/** Host half: session projection and authenticated, read-only Git route. */

import { readFile, stat } from 'node:fs/promises'
import { basename, isAbsolute, relative, resolve, sep } from 'node:path'
import { createProjectionDefinition } from './projection.js'
import { GitBranchReader } from './git.js'
import {
  RemoteRegistry, extractRemotePaths, extractScriptReferences, parseSshInvocations,
  parseWrapperScript, remoteLabel, remoteProjectId,
} from './remote.js'
import { RepoActionError, RepoManager, resolveProjectPath } from './repo.js'
import { CredentialVault } from './credentials.js'

export const name = 'git-branch-graph'
export const inject = ['sessionProjections', 'sessions', 'subprocess', 'connection']

const ROUTE = '/api/git-branch-graph'
const PROJECTS_ROUTE = '/api/git-branch-graph/projects'
const REPO_ROUTE = '/api/git-branch-graph/repo'
const DIRECTORIES_ROUTE = '/api/git-branch-graph/directories'
const CREDENTIALS_ROUTE = '/api/git-branch-graph/credentials'
const MANAGE_ROUTE = '/api/git-branch-graph/manage'
const MAX_MANAGE_BODY_BYTES = 64 * 1024

function errorBody(error) {
  if (error instanceof RepoActionError) {
    return { ok: false, error: { code: error.code, message: error.message, details: error.details } }
  }
  return { ok: false, error: { code: 'internal', message: 'The repository operation failed.', details: {} } }
}

function requestProject(ctx, projection, sessionId) {
  if (sessionId === null || sessionId === '') {
    return { error: json({ ok: false, error: { code: 'invalid-session', message: 'A Session id is required.', details: {} } }, 400) }
  }
  const session = ctx.sessions.get(sessionId)
  if (session === undefined || session === null) {
    return { error: json({ ok: false, error: { code: 'session-not-live', message: 'Open the conversation before managing its repository.', details: {} } }, 409) }
  }
  const state = projection.stateOf(session)
  if (!state.development) {
    return { error: json({ ok: false, error: { code: 'not-development', message: 'Repository creation is available only in a development task.', details: {} } }, 403) }
  }
  if (state.cwd === null) {
    return { error: json({ ok: false, error: { code: 'no-project', message: 'This Session has no project directory.', details: {} } }, 409) }
  }
  return { cwd: state.cwd }
}

function json(value, status = 200) {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store' } })
}

async function readCappedText(request, limit) {
  if (request.body === null) return ''
  const reader = request.body.getReader()
  const chunks = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > limit) {
        await reader.cancel().catch(() => {})
        throw new RepoActionError('body-too-large', 'The repository request is too large.')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

export async function apply(ctx) {
  const projection = await ctx.sessionProjections.register(createProjectionDefinition())
  const reader = new GitBranchReader(ctx)
  const repo = new RepoManager(ctx)
  const credentials = new CredentialVault(ctx)
  const remotes = new RemoteRegistry()
  const scriptCache = new Map()
  const rootsCache = new Map()
  const lifetime = new AbortController()
  const pending = new Set()

  const connectionKey = connection => `${connection.user ?? ''}@${connection.host}:${connection.port}:${connection.key ?? ''}`

  const scriptConnections = async (scriptPath) => {
    try {
      const info = await stat(scriptPath)
      if (!info.isFile() || info.size > 64 * 1024) return []
      const cached = scriptCache.get(scriptPath)
      if (cached !== undefined && cached.mtimeMs === info.mtimeMs) return cached.connections
      const text = await readFile(scriptPath, 'utf8')
      const connections = parseWrapperScript(text)
      scriptCache.set(scriptPath, { mtimeMs: info.mtimeMs, connections })
      return connections
    } catch {
      return []
    }
  }

  const discoverRemotes = async (state, signal, sessionId) => {
    const groups = new Map()
    for (const hint of state.remoteHints ?? []) {
      const paths = extractRemotePaths(hint.text)
      if (paths.length === 0) continue
      const connections = parseSshInvocations(hint.text)
      for (const reference of extractScriptReferences(hint.text)) {
        const scriptPath = isAbsolute(reference) ? reference : resolve(state.cwd, reference)
        if (!scriptPath.includes('\0')) connections.push(...await scriptConnections(scriptPath))
      }
      const unique = new Map()
      for (const connection of connections) unique.set(connectionKey(connection), connection)
      for (const connection of unique.values()) {
        const key = connectionKey(connection)
        let group = groups.get(key)
        if (group === undefined) {
          group = { connection, paths: new Map(), seq: hint.seq }
          groups.set(key, group)
        }
        for (const path of paths) {
          group.paths.set(path, Math.max(hint.seq, group.paths.get(path) ?? 0))
        }
        group.seq = Math.max(group.seq, hint.seq)
      }
    }

    for (const [id, value] of remotes.projects) {
      if (value.sessionId === sessionId) remotes.projects.delete(id)
    }
    const projects = []
    for (const group of groups.values()) {
      const candidates = [...group.paths.entries()]
        .filter(([path]) => {
          if (path.startsWith('/mnt/')) return false
          const parts = path.split('/').filter(Boolean)
          return parts.at(-1) !== parts.at(-2)
        })
        .sort((left, right) => right[1] - left[1])
        .slice(0, 12)
      const deepest = candidates
        .filter(([path]) => !candidates.some(([other]) => other !== path && other.startsWith(`${path}/`)))
        .slice(0, 8)
      let roots = null
      const key = `${connectionKey(group.connection)}\n${deepest.map(([path]) => path).join('\n')}`
      const cached = rootsCache.get(key)
      if (cached !== undefined && cached.expires > Date.now()) {
        roots = cached.roots
      } else {
        try {
          const verifySignal = AbortSignal.any([signal, AbortSignal.timeout(6_000)])
          roots = await reader.resolveRemoteRoots(group.connection, deepest.map(([path]) => path), verifySignal)
          rootsCache.set(key, { roots, expires: Date.now() + 60_000 })
        } catch (error) {
          if (signal.aborted) throw error
          rootsCache.set(key, { roots: null, expires: Date.now() + 30_000 })
        }
      }
      const resolved = roots !== null && roots.length > 0
        ? roots.map(root => ({ path: root.root, seq: group.seq }))
        : deepest.map(([path, seq]) => ({ path, seq }))
      for (const entry of resolved) {
        const id = remoteProjectId(group.connection, `${sessionId}\0${entry.path}`)
        if (remotes.get(id) !== undefined) continue
        const project = {
          id,
          path: entry.path,
          label: remoteLabel(entry.path),
          lastSeq: entry.seq,
          source: 'remote',
          remote: true,
          host: group.connection.host,
        }
        remotes.set(id, { connection: group.connection, path: entry.path, sessionId })
        projects.push(project)
      }
    }
    return projects
  }

  ctx.effect(() => async () => {
    credentials.clear()
    remotes.clear()
    lifetime.abort()
    await Promise.allSettled([...pending])
  }, 'git-branch-graph: cancel Git reads')

  ctx.connection.fetch.register({
    path: ROUTE,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const query = new URL(request.url).searchParams
      const sessionId = query.get('sessionId')
      if (sessionId === null || sessionId === '') return json({ status: 'error', reason: 'invalid-session' }, 400)
      const session = ctx.sessions.get(sessionId)
      // A historical conversation can be browsed without a live Host Session.
      // Treat that as an expected hidden state, not a graph error.
      if (session === undefined || session === null) return json({ status: 'unavailable', reason: 'session-not-live' })

      const state = projection.stateOf(session)
      if (!state.development) return json({ status: 'unavailable', reason: 'not-development' })
      if (state.cwd === null) return json({ status: 'unavailable', reason: 'no-project' })

      const remoteId = query.get('remoteProject')
      const signal = AbortSignal.any([request.signal, lifetime.signal])
      let task
      if (remoteId !== null && remoteId !== '') {
        const remote = remotes.get(remoteId)
        if (remote === undefined || remote.sessionId !== sessionId) {
          return json({ status: 'error', reason: 'remote-project-unavailable' }, 404)
        }
        task = reader.readRemote(remote.connection, remote.path, signal)
      } else {
        let projectCwd = state.cwd
        const relativePath = query.get('path')
        if (relativePath !== null && relativePath !== '') {
          try {
            projectCwd = (await resolveProjectPath(state.cwd, relativePath)).target
          } catch {
            return json({ status: 'error', reason: 'invalid-project-path' }, 400)
          }
        }
        task = reader.read(projectCwd, signal)
      }
      pending.add(task)
      try {
        return json(await task)
      } catch (error) {
        if (signal.aborted) return json({ status: 'error', reason: 'cancelled' }, 499)
        ctx.logger.warn(`git-branch-graph: ${error instanceof Error ? error.message : String(error)}`)
        return json({ status: 'error', reason: 'git-read-failed' }, 500)
      } finally {
        pending.delete(task)
      }
    },
  })

  ctx.connection.fetch.register({
    path: PROJECTS_ROUTE,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const query = new URL(request.url).searchParams
      const sessionId = query.get('sessionId')
      if (sessionId === null || sessionId === '') return json({ status: 'error', reason: 'invalid-session' }, 400)
      const session = ctx.sessions.get(sessionId)
      if (session === undefined || session === null) return json({ status: 'unavailable', reason: 'session-not-live' })
      const state = projection.stateOf(session)
      if (!state.development) return json({ status: 'unavailable', reason: 'not-development' })
      if (state.cwd === null) return json({ status: 'unavailable', reason: 'no-project' })

      const signal = AbortSignal.any([request.signal, lifetime.signal])
      const task = (async () => {
        const projects = []
        const seen = new Set()
        for (const candidate of state.projects) {
          let base
          let target
          try {
            const resolved = await resolveProjectPath(state.cwd, candidate.path)
            base = resolved.root
            target = resolved.target
          } catch {
            continue
          }
          const root = await reader.root(target, signal)
          let path = candidate.path
          let label = candidate.label
          if (root !== null) {
            const rel = relative(base, root)
            if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
              path = ''
            } else {
              path = rel.split(sep).join('/')
            }
            label = basename(root) || candidate.label
          }
          const id = path === '' ? 'root' : path
          if (seen.has(id)) continue
          seen.add(id)
          projects.push({ ...candidate, id, path, label })
        }
        for (const remote of await discoverRemotes(state, signal, sessionId)) {
          if (seen.has(remote.id)) continue
          seen.add(remote.id)
          projects.push(remote)
        }
        return {
          status: 'ok',
          projects: projects.sort((left, right) => right.lastSeq - left.lastSeq),
          activeProjectId: projects[0]?.id ?? null,
        }
      })()
      pending.add(task)
      try {
        return json(await task)
      } catch (error) {
        if (signal.aborted) return json({ status: 'error', reason: 'cancelled' }, 499)
        ctx.logger.warn(`git-branch-graph projects: ${error instanceof Error ? error.message : String(error)}`)
        return json({ status: 'error', reason: 'projects-failed' }, 500)
      } finally {
        pending.delete(task)
      }
    },
  })

  ctx.connection.fetch.register({
    path: REPO_ROUTE,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const query = new URL(request.url).searchParams
      const project = requestProject(ctx, projection, query.get('sessionId'))
      if ('error' in project) return project.error
      const signal = AbortSignal.any([request.signal, lifetime.signal])
      const task = repo.preview(project.cwd, query.get('path') ?? '', signal)
      pending.add(task)
      try {
        return json(await task)
      } catch (error) {
        if (signal.aborted) return json({ status: 'error', code: 'cancelled', message: 'Cancelled.' })
        if (!(error instanceof RepoActionError)) {
          ctx.logger.warn(`git-branch-graph preview: ${error instanceof Error ? error.message : String(error)}`)
        }
        return json({
          status: 'error',
          ...(error instanceof RepoActionError
            ? { code: error.code, message: error.message, details: error.details }
            : { code: 'preview-failed', message: 'Could not inspect this project.', details: {} }),
        })
      } finally {
        pending.delete(task)
      }
    },
  })

  ctx.connection.fetch.register({
    path: DIRECTORIES_ROUTE,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const query = new URL(request.url).searchParams
      const project = requestProject(ctx, projection, query.get('sessionId'))
      if ('error' in project) return project.error
      const signal = AbortSignal.any([request.signal, lifetime.signal])
      const task = repo.browse(project.cwd, query.get('path') ?? '', signal)
      pending.add(task)
      try {
        return json(await task)
      } catch (error) {
        if (signal.aborted) return json({ status: 'error', code: 'cancelled', message: 'Cancelled.' })
        if (!(error instanceof RepoActionError)) {
          ctx.logger.warn(`git-branch-graph directories: ${error instanceof Error ? error.message : String(error)}`)
        }
        return json({
          status: 'error',
          ...(error instanceof RepoActionError
            ? { code: error.code, message: error.message, details: error.details }
            : { code: 'browse-failed', message: 'Could not read this directory.', details: {} }),
        })
      } finally {
        pending.delete(task)
      }
    },
  })

  ctx.connection.fetch.register({
    path: CREDENTIALS_ROUTE,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const query = new URL(request.url).searchParams
      const project = requestProject(ctx, projection, query.get('sessionId'))
      if ('error' in project) return project.error
      const provider = query.get('provider')
      if (provider !== 'github' && provider !== 'gitee') {
        return json(errorBody(new RepoActionError('invalid-provider', 'Choose GitHub or Gitee.')), 400)
      }
      const signal = AbortSignal.any([request.signal, lifetime.signal])
      const task = credentials.list(provider, signal, query.get('refresh') === '1')
      pending.add(task)
      try {
        return json({ status: 'ok', provider, credentials: await task })
      } catch {
        return json({ status: 'ok', provider, credentials: [] })
      } finally {
        pending.delete(task)
      }
    },
  })

  ctx.connection.fetch.register({
    path: MANAGE_ROUTE,
    methods: ['POST'],
    requestBody: 'streaming',
    fetch: async (request) => {
      const declared = Number(request.headers.get('content-length') ?? '0')
      if (Number.isFinite(declared) && declared > MAX_MANAGE_BODY_BYTES) {
        return json(errorBody(new RepoActionError('body-too-large', 'The repository request is too large.')), 413)
      }
      let text
      try {
        text = await readCappedText(request, MAX_MANAGE_BODY_BYTES)
      } catch (error) {
        return json(errorBody(error), 413)
      }
      let input
      try {
        input = JSON.parse(text)
      } catch {
        return json(errorBody(new RepoActionError('invalid-request', 'The repository request is not valid JSON.')), 400)
      }
      if (typeof input !== 'object' || input === null || Array.isArray(input)) {
        return json(errorBody(new RepoActionError('invalid-request', 'The repository request is invalid.')), 400)
      }
      const project = requestProject(ctx, projection, typeof input.sessionId === 'string' ? input.sessionId : null)
      if ('error' in project) return project.error

      let action = input
      if ((input.provider === 'github' || input.provider === 'gitee') && typeof input.credentialId === 'string') {
        const credential = credentials.get(input.credentialId, input.provider)
        if (credential === undefined) {
          return json(errorBody(new RepoActionError('credential-expired',
            'The selected local credential is no longer available. Refresh the credential list.')), 400)
        }
        action = { ...input, token: credential.secret }
      }

      const signal = AbortSignal.any([request.signal, lifetime.signal])
      const task = repo.publish(project.cwd, action, signal)
      pending.add(task)
      try {
        return json({ ok: true, result: await task })
      } catch (error) {
        if (signal.aborted) {
          return json(errorBody(new RepoActionError('cancelled', 'The repository operation was cancelled.')), 499)
        }
        if (!(error instanceof RepoActionError)) {
          ctx.logger.warn(`git-branch-graph manage: ${error instanceof Error ? error.message : String(error)}`)
        }
        return json(errorBody(error), error instanceof RepoActionError ? 200 : 500)
      } finally {
        pending.delete(task)
      }
    },
  })
}

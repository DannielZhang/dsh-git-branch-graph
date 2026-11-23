/** Host half: session projection and authenticated, read-only Git route. */

import { createProjectionDefinition } from './projection.js'
import { GitBranchReader } from './git.js'
import { RepoActionError, RepoManager, resolveProjectPath } from './repo.js'

export const name = 'git-branch-graph'
export const inject = ['sessionProjections', 'sessions', 'subprocess', 'connection']

const ROUTE = '/api/git-branch-graph'
const REPO_ROUTE = '/api/git-branch-graph/repo'
const DIRECTORIES_ROUTE = '/api/git-branch-graph/directories'
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
  const lifetime = new AbortController()
  const pending = new Set()

  ctx.effect(() => async () => {
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

      let projectCwd = state.cwd
      const relativePath = query.get('path')
      if (relativePath !== null && relativePath !== '') {
        try {
          projectCwd = (await resolveProjectPath(state.cwd, relativePath)).target
        } catch {
          return json({ status: 'error', reason: 'invalid-project-path' }, 400)
        }
      }

      const signal = AbortSignal.any([request.signal, lifetime.signal])
      const task = reader.read(projectCwd, signal)
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

      const signal = AbortSignal.any([request.signal, lifetime.signal])
      const task = repo.publish(project.cwd, input, signal)
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

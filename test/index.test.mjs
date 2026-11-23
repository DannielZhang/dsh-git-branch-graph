import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { apply } from '../index.js'

function localSubprocess() {
  return {
    async resolveExecutable() { return 'git' },
    spawn(spec) {
      const child = spawn(spec.argv[0], spec.argv.slice(1), {
        cwd: spec.cwd,
        env: { ...process.env, ...spec.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const stdout = []
      const stderr = []
      child.stdout.on('data', chunk => stdout.push(chunk))
      child.stderr.on('data', chunk => stderr.push(chunk))
      spec.signal?.addEventListener('abort', () => { child.kill('SIGTERM') }, { once: true })
      return {
        collected: {
          stdout: { readFrom: () => ({ text: Buffer.concat(stdout).toString('utf8'), lossy: false }) },
          stderr: { readFrom: () => ({ text: Buffer.concat(stderr).toString('utf8'), lossy: false }) },
        },
        done: new Promise((resolve, reject) => {
          child.once('error', reject)
          child.once('close', (exitCode, signal) => resolve({ exitCode, signal }))
        }),
      }
    },
  }
}

test('Host apply registers the projection route and answers for its Session', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-git-route-'))
  t.after(async () => { await rm(directory, { recursive: true, force: true }) })
  execFileSync('git', ['init', '-b', 'main'], { cwd: directory })
  await writeFile(join(directory, 'README.md'), '# Fixture\n')
  execFileSync('git', ['add', 'README.md'], { cwd: directory })
  execFileSync('git', ['commit', '-m', 'Initial commit'], {
    cwd: directory,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Route Test', GIT_AUTHOR_EMAIL: 'route@example.invalid',
      GIT_COMMITTER_NAME: 'Route Test', GIT_COMMITTER_EMAIL: 'route@example.invalid',
    },
  })

  const session = { id: 'route-session' }
  let state = { development: true, cwd: directory, revision: 1, source: 'session' }
  const routes = new Map()
  let definition
  const cleanups = []
  const ctx = {
    sessionProjections: {
      async register(value) {
        definition = value
        return { stateOf: () => state }
      },
    },
    sessions: { get: id => id === 'route-session' ? session : undefined },
    subprocess: localSubprocess(),
    connection: { fetch: { register(value) { routes.set(value.path, value); return async () => {} } } },
    effect(fn) { cleanups.push(fn()) },
    logger: { warn() {} },
  }

  await apply(ctx)
  assert.equal(definition.key, 'gitBranchGraph')
  assert.deepEqual([...routes.keys()], [
    '/api/git-branch-graph', '/api/git-branch-graph/repo',
    '/api/git-branch-graph/directories', '/api/git-branch-graph/manage',
  ])
  const route = routes.get('/api/git-branch-graph')
  assert.deepEqual(route.methods, ['GET'])
  assert.deepEqual(routes.get('/api/git-branch-graph/repo').methods, ['GET'])
  assert.deepEqual(routes.get('/api/git-branch-graph/directories').methods, ['GET'])
  assert.deepEqual(routes.get('/api/git-branch-graph/manage').methods, ['POST'])

  const response = await route.fetch(new Request('http://dsh.invalid/api/git-branch-graph?sessionId=route-session'))
  assert.equal(response.status, 200)
  const graph = await response.json()
  assert.equal(graph.status, 'ok')
  assert.equal(graph.currentBranch, 'main')
  assert.equal(graph.commits.length, 1)
  assert.equal(graph.projectName, directory.split('/').at(-1))

  state = { ...state, development: false }
  const hidden = await route.fetch(new Request('http://dsh.invalid/api/git-branch-graph?sessionId=route-session'))
  assert.deepEqual(await hidden.json(), { status: 'unavailable', reason: 'not-development' })

  const missing = await route.fetch(new Request('http://dsh.invalid/api/git-branch-graph?sessionId=unknown'))
  assert.equal(missing.status, 200)
  assert.deepEqual(await missing.json(), { status: 'unavailable', reason: 'session-not-live' })

  for (const cleanup of cleanups) await cleanup()
})

test('Host preview and manage routes can initialize a safe local repository', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-git-manage-'))
  t.after(async () => { await rm(directory, { recursive: true, force: true }) })
  const project = join(directory, 'project')
  await mkdir(project, { recursive: true })
  await writeFile(join(project, 'README.md'), '# Managed\n')
  await writeFile(join(project, '.env'), 'SECRET=nope\n')

  const session = { id: 'manage-session' }
  const state = { development: true, cwd: directory, revision: 1, source: 'session' }
  const routes = new Map()
  const cleanups = []
  const ctx = {
    sessionProjections: {
      async register() { return { stateOf: () => state } },
    },
    sessions: { get: id => id === 'manage-session' ? session : undefined },
    subprocess: localSubprocess(),
    connection: { fetch: { register(value) { routes.set(value.path, value); return async () => {} } } },
    effect(fn) { cleanups.push(fn()) },
    logger: { warn() {} },
  }
  await apply(ctx)

  const previewRoute = routes.get('/api/git-branch-graph/repo')
  const previewResponse = await previewRoute.fetch(new Request(
    `http://dsh.invalid/api/git-branch-graph/repo?sessionId=manage-session&path=project`,
  ))
  const preview = await previewResponse.json()
  assert.equal(preview.status, 'ok')
  assert.equal(preview.fileCount, 1)
  assert.equal(preview.relativePath, 'project')
  assert.deepEqual(preview.sampleFiles, ['README.md'])

  const escape = await previewRoute.fetch(new Request(
    `http://dsh.invalid/api/git-branch-graph/repo?sessionId=manage-session&path=..`,
  ))
  assert.equal((await escape.json()).code, 'invalid-path')

  const browseRoute = routes.get('/api/git-branch-graph/directories')
  const rootBrowse = await browseRoute.fetch(new Request(
    'http://dsh.invalid/api/git-branch-graph/directories?sessionId=manage-session&path=',
  ))
  const rootDirs = await rootBrowse.json()
  assert.equal(rootDirs.status, 'ok')
  assert.equal(rootDirs.parent, null)
  assert.deepEqual(rootDirs.directories.map(dir => dir.name), ['project'])
  const childBrowse = await browseRoute.fetch(new Request(
    'http://dsh.invalid/api/git-branch-graph/directories?sessionId=manage-session&path=project',
  ))
  assert.equal((await childBrowse.json()).parent, '')

  const manageRoute = routes.get('/api/git-branch-graph/manage')
  assert.equal(manageRoute.requestBody, 'streaming')
  const tooLarge = await manageRoute.fetch(new Request('http://dsh.invalid/api/git-branch-graph/manage', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 'manage-session', padding: 'x'.repeat(70_000) }),
  }))
  assert.equal(tooLarge.status, 413)
  assert.equal((await tooLarge.json()).error.code, 'body-too-large')

  const managed = await manageRoute.fetch(new Request('http://dsh.invalid/api/git-branch-graph/manage', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sessionId: 'manage-session',
      path: 'project',
      projectName: 'Managed',
      authorName: 'Route Test',
      authorEmail: 'route@example.invalid',
      createGitignore: true,
      provider: 'none',
    }),
  }))
  assert.equal(managed.status, 200)
  const result = await managed.json()
  assert.equal(result.ok, true)
  assert.equal(result.result.initialized, true)
  assert.equal(result.result.committed, true)
  assert.equal(result.result.relativePath, 'project')

  const graph = await routes.get('/api/git-branch-graph').fetch(new Request(
    'http://dsh.invalid/api/git-branch-graph?sessionId=manage-session&path=project',
  ))
  const graphValue = await graph.json()
  assert.equal(graphValue.status, 'ok')
  assert.equal(graphValue.commits.length, 1)
  const withoutOverride = await routes.get('/api/git-branch-graph').fetch(new Request(
    'http://dsh.invalid/api/git-branch-graph?sessionId=manage-session',
  ))
  assert.deepEqual(await withoutOverride.json(), { status: 'unavailable', reason: 'not-git' })

  for (const cleanup of cleanups) await cleanup()
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import {
  RepoManager, __test, buildPushEnv, isUnsafePath, redactRemoteUrl, resolveProjectPath, validateRemoteUrl,
} from '../repo.js'

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

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-gbr-test-'))
  await mkdir(join(root, 'src'), { recursive: true })
  await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true })
  await writeFile(join(root, 'README.md'), '# Fixture\n')
  await writeFile(join(root, 'src', 'index.js'), 'export const value = 1\n')
  await writeFile(join(root, '.env'), 'TOKEN=secret\n')
  await writeFile(join(root, 'node_modules', 'pkg', 'index.js'), 'ignored\n')
  return root
}

test('project paths cannot escape the current workspace', async t => {
  const root = await fixture()
  t.after(async () => { await rm(root, { recursive: true, force: true }) })
  await assert.rejects(resolveProjectPath(root, '../escape'), error => error.code === 'invalid-path')
  await assert.rejects(resolveProjectPath(root, '/etc'), error => error.code === 'invalid-path')
  assert.ok((await resolveProjectPath(root, 'src')).target.endsWith('/src'))
})

test('preview respects safety excludes and reports safe files', async t => {
  const root = await fixture()
  t.after(async () => { await rm(root, { recursive: true, force: true }) })
  const manager = new RepoManager({ subprocess: localSubprocess() }, { executable: 'git' })
  const preview = await manager.preview(root, '', new AbortController().signal)
  assert.equal(preview.status, 'ok')
  assert.equal(preview.isGit, false)
  assert.equal(preview.fileCount, 2)
  assert.deepEqual(preview.sampleFiles.sort(), ['README.md', 'src/index.js'])
  assert.equal(preview.hasGitignore, false)
  assert.equal(preview.largestFile.path, 'src/index.js')
})

test('publish creates a safe local repository and first commit', async t => {
  const root = await fixture()
  t.after(async () => { await rm(root, { recursive: true, force: true }) })
  const manager = new RepoManager({ subprocess: localSubprocess() }, { executable: 'git' })
  const result = await manager.publish(root, {
    path: '',
    projectName: 'Fixture',
    authorName: 'Repo Test',
    authorEmail: 'repo@example.invalid',
    createGitignore: true,
    provider: 'none',
  }, new AbortController().signal)
  assert.equal(result.initialized, true)
  assert.equal(result.committed, true)
  assert.equal(result.pushed, false)
  assert.equal(result.branch, 'main')
  assert.match(result.commit, /^[0-9a-f]{40}$/)
  assert.match(execFileSync('git', ['log', '-1', '--format=%s'], { cwd: root, encoding: 'utf8' }), /Initial commit/)
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }), '')
  assert.match(await readFile(join(root, '.git', 'info', 'exclude'), 'utf8'), /dsh-git-branch-graph/)
  assert.match(await readFile(join(root, '.gitignore'), 'utf8'), /node_modules/)
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0')
  assert.ok(tracked.includes('README.md'))
  assert.ok(tracked.includes('src/index.js'))
  assert.ok(!tracked.includes('.env'))
  assert.ok(!tracked.includes('node_modules/pkg/index.js'))
})

test('remote URL and token helpers reject unsafe input', () => {
  assert.equal(validateRemoteUrl('https://git.example.com/team/repo.git'), 'https://git.example.com/team/repo.git')
  assert.equal(validateRemoteUrl('git@git.example.com:team/repo.git'), 'git@git.example.com:team/repo.git')
  assert.throws(() => validateRemoteUrl('https://user:secret@example.com/repo'), error => error.code === 'invalid-remote-url')
  assert.throws(() => validateRemoteUrl('http://example.com/repo'), error => error.code === 'invalid-remote-url')
  assert.throws(() => validateRemoteUrl('https://example.com/repo?access_token=secret'), error => error.code === 'invalid-remote-url')
  assert.throws(() => validateRemoteUrl('git://example.com/repo.git'), error => error.code === 'invalid-remote-url')
  assert.throws(() => validateRemoteUrl('user:secret@example.com:repo.git'), error => error.code === 'invalid-remote-url')
  assert.equal(redactRemoteUrl('https://user:secret@example.com/repo.git'), 'https://example.com/repo.git')
  assert.equal(
    redactRemoteUrl('https://example.com/repo.git?access_token=secret'),
    'https://example.com/repo.git?access_token=%5Bredacted%5D',
  )
  const env = buildPushEnv('github', 'ghp_example')
  assert.equal(env.GIT_CONFIG_COUNT, '1')
  assert.equal(env.GIT_CONFIG_KEY_0, 'http.https://github.com/.extraheader')
  assert.ok(env.GIT_CONFIG_VALUE_0.startsWith('Authorization: Basic '))
  assert.ok(!JSON.stringify(env).includes('ghp_example'))
  const hardened = buildPushEnv('github', 'ghp_example', '/tmp/empty-hooks')
  assert.equal(hardened.GIT_CONFIG_COUNT, '2')
  assert.equal(hardened.GIT_CONFIG_KEY_0, 'core.hooksPath')
  assert.equal(hardened.GIT_CONFIG_KEY_1, 'http.https://github.com/.extraheader')
})

test('preview rejects an existing .git symlink before initialization', async t => {
  const root = await fixture()
  const external = await mkdtemp(join(tmpdir(), 'dsh-gbr-external-'))
  t.after(async () => {
    await rm(root, { recursive: true, force: true })
    await rm(external, { recursive: true, force: true })
  })
  await symlink(external, join(root, '.git'), 'dir')
  const manager = new RepoManager({ subprocess: localSubprocess() }, { executable: 'git' })
  await assert.rejects(
    manager.preview(root, '', new AbortController().signal),
    error => error.code === 'unsafe-git-dir',
  )
})

test('a .gitignore negation cannot put .env into the first commit', async t => {
  const root = await fixture()
  t.after(async () => { await rm(root, { recursive: true, force: true }) })
  await writeFile(join(root, '.gitignore'), '!.env\n')
  const manager = new RepoManager({ subprocess: localSubprocess() }, { executable: 'git' })
  const preview = await manager.preview(root, '', new AbortController().signal)
  assert.equal(preview.status, 'ok')
  assert.ok(!preview.sampleFiles.includes('.env'))
  await manager.publish(root, {
    path: '',
    projectName: 'Fixture',
    authorName: 'Repo Test',
    authorEmail: 'repo@example.invalid',
    createGitignore: false,
    provider: 'none',
  }, new AbortController().signal)
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0')
  assert.ok(!tracked.includes('.env'))
  assert.ok(tracked.includes('.gitignore'))
})

test('an existing repository with no commit gets a previewed first commit', async t => {
  const root = await fixture()
  t.after(async () => { await rm(root, { recursive: true, force: true }) })
  execFileSync('git', ['init', '-b', 'main'], { cwd: root })
  const manager = new RepoManager({ subprocess: localSubprocess() }, { executable: 'git' })
  const preview = await manager.preview(root, '', new AbortController().signal)
  assert.equal(preview.status, 'ok')
  assert.equal(preview.isGit, true)
  assert.equal(preview.hasCommit, false)
  assert.equal(preview.fileCount, 2)
  assert.ok(!preview.sampleFiles.includes('.env'))

  const result = await manager.publish(root, {
    path: '',
    projectName: 'Fixture',
    authorName: 'Repo Test',
    authorEmail: 'repo@example.invalid',
    createGitignore: true,
    provider: 'none',
  }, new AbortController().signal)
  assert.equal(result.initialized, false)
  assert.equal(result.committed, true)
  assert.equal(result.pushed, false)
  assert.match(execFileSync('git', ['log', '-1', '--format=%s'], { cwd: root, encoding: 'utf8' }), /Initial commit/)
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0')
  assert.ok(tracked.includes('README.md'))
  assert.ok(!tracked.includes('.env'))
  assert.ok(!tracked.includes('node_modules/pkg/index.js'))
})

test('unsafe origin schemes are marked unusable and rejected for push', async t => {
  const root = await fixture()
  t.after(async () => { await rm(root, { recursive: true, force: true }) })
  execFileSync('git', ['init', '-b', 'main'], { cwd: root })
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/team/repo.git'], { cwd: root })
  execFileSync('git', ['remote', 'set-url', '--push', 'origin', 'file:///tmp/evil.git'], { cwd: root })
  execFileSync('git', ['add', 'README.md'], { cwd: root })
  execFileSync('git', ['commit', '-m', 'Initial commit'], {
    cwd: root,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Repo Test', GIT_AUTHOR_EMAIL: 'repo@example.invalid',
      GIT_COMMITTER_NAME: 'Repo Test', GIT_COMMITTER_EMAIL: 'repo@example.invalid',
    },
  })
  const manager = new RepoManager({ subprocess: localSubprocess() }, { executable: 'git' })
  const preview = await manager.preview(root, '', new AbortController().signal)
  assert.equal(preview.status, 'ok')
  assert.equal(preview.remotes.find(remote => remote.name === 'origin').usable, false)
  await assert.rejects(
    manager.publish(root, {
      path: '', projectName: 'Fixture', authorName: 'A', authorEmail: 'a@example.invalid',
      provider: 'existing',
    }, new AbortController().signal),
    error => error.code === 'invalid-remote-url',
  )
})

test('configuring a new origin clears stale push URLs', async t => {
  const root = await fixture()
  t.after(async () => { await rm(root, { recursive: true, force: true }) })
  execFileSync('git', ['init', '-b', 'main'], { cwd: root })
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/team/repo.git'], { cwd: root })
  execFileSync('git', ['remote', 'set-url', '--push', 'origin', 'file:///tmp/evil.git'], { cwd: root })
  const manager = new RepoManager({ subprocess: localSubprocess() }, { executable: 'git' })
  const executable = await manager.executable(new AbortController().signal)
  await manager.configureOrigin(executable, root, 'https://git.example.com/team/safe.git', new AbortController().signal)
  const pushUrls = execFileSync('git', ['remote', 'get-url', '--push', '--all', 'origin'], { cwd: root, encoding: 'utf8' }).trim()
  assert.equal(pushUrls, 'https://git.example.com/team/safe.git')
})

test('path safety treats .env directories and secret directories as unsafe', () => {
  assert.equal(isUnsafePath('.env.example'), false)
  assert.equal(isUnsafePath('.env/prod'), true)
  assert.equal(isUnsafePath('config/.env.local'), true)
  assert.equal(isUnsafePath('.aws/credentials'), true)
  assert.equal(isUnsafePath('.ssh/id_rsa'), true)
})

test('a re-included .env directory is excluded from preview and commit', async t => {
  const root = await fixture()
  t.after(async () => { await rm(root, { recursive: true, force: true }) })
  await rm(join(root, '.env'), { force: true })
  await mkdir(join(root, '.env'), { recursive: true })
  await writeFile(join(root, '.env', 'prod'), 'SECRET=nope\n')
  await writeFile(join(root, '.gitignore'), '!.env/\n')
  await mkdir(join(root, '.aws'), { recursive: true })
  await writeFile(join(root, '.aws', 'credentials'), 'aws_secret_access_key=nope\n')
  const manager = new RepoManager({ subprocess: localSubprocess() }, { executable: 'git' })
  const preview = await manager.preview(root, '', new AbortController().signal)
  assert.equal(preview.status, 'ok')
  assert.ok(!preview.sampleFiles.some(path => path.startsWith('.env/')))
  await assert.rejects(
    manager.preview(root, '.env', new AbortController().signal),
    error => error.code === 'unsafe-path',
  )
  const browse = await manager.browse(root, '', new AbortController().signal)
  assert.ok(!browse.directories.some(directory => directory.name === '.env'))
  assert.ok(!browse.directories.some(directory => directory.name === '.aws'))
  await manager.publish(root, {
    path: '',
    projectName: 'Fixture',
    authorName: 'Repo Test',
    authorEmail: 'repo@example.invalid',
    createGitignore: false,
    provider: 'none',
  }, new AbortController().signal)
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0')
  assert.ok(!tracked.some(path => path.startsWith('.env/')))
})

test('repo-local insteadOf cannot redirect a newly configured origin', async t => {
  const root = await fixture()
  t.after(async () => { await rm(root, { recursive: true, force: true }) })
  execFileSync('git', ['init', '-b', 'main'], { cwd: root })
  execFileSync('git', ['config', 'url.file:///tmp/outside/.insteadOf', 'https://git.example.com/'], { cwd: root })
  const manager = new RepoManager({ subprocess: localSubprocess() }, { executable: 'git' })
  const executable = await manager.executable(new AbortController().signal)
  await assert.rejects(
    manager.configureOrigin(executable, root, 'https://git.example.com/team/safe.git', new AbortController().signal),
    error => error.code === 'invalid-remote-url' || error.code === 'remote-redirect',
  )
})

test('remote list omits credentials from display and flags unsupported schemes', () => {
  const remotes = __test.remoteList([
    'origin\thttps://user:secret@example.com/team/repo.git (fetch)',
    'origin\thttps://user:secret@example.com/team/repo.git (push)',
    'bad\tfile:///tmp/repo.git (fetch)',
  ].join('\n'))
  assert.equal(remotes.find(remote => remote.name === 'origin').url, 'https://example.com/team/repo.git')
  assert.equal(remotes.find(remote => remote.name === 'origin').usable, false)
  assert.equal(remotes.find(remote => remote.name === 'bad').usable, false)
})

test('GitHub remote creation uses the token only in the request header', async t => {
  let request
  const manager = new RepoManager(
    { subprocess: localSubprocess() },
    {
      executable: 'git',
      fetchImpl: async (url, init) => {
        request = { url, init }
        return new Response(JSON.stringify({ full_name: 'acme/demo', html_url: 'https://github.com/acme/demo' }), {
          status: 201, headers: { 'content-type': 'application/json' },
        })
      },
    },
  )
  const result = await manager.createRemote('github', 'ghp_secret', 'demo', true, new AbortController().signal)
  assert.equal(result.remoteUrl, 'https://github.com/acme/demo.git')
  assert.equal(request.url, 'https://api.github.com/user/repos')
  assert.equal(request.init.headers.Authorization, 'token ghp_secret')
  assert.ok(!request.url.includes('ghp_secret'))
  assert.ok(!request.init.body.includes('ghp_secret'))
  assert.equal(JSON.parse(request.init.body).private, true)
})

test('Gitee creation uses the v5 endpoint and keeps the token out of the URL', async t => {
  let request
  const manager = new RepoManager(
    { subprocess: localSubprocess() },
    {
      executable: 'git',
      fetchImpl: async (url, init) => {
        request = { url, init }
        return new Response(JSON.stringify({ full_name: 'team/demo', html_url: 'https://gitee.com/team/demo' }), {
          status: 201, headers: { 'content-type': 'application/json' },
        })
      },
    },
  )
  const result = await manager.createRemote('gitee', 'gitee_secret', 'demo', false, new AbortController().signal)
  assert.equal(result.remoteUrl, 'https://gitee.com/team/demo.git')
  assert.equal(request.url, 'https://gitee.com/api/v5/user/repos')
  assert.ok(!request.url.includes('gitee_secret'))
  assert.equal(request.init.headers.Authorization, 'token gitee_secret')
  assert.equal(JSON.parse(request.init.body).access_token, 'gitee_secret')
})

test('preview blocks a file above the single-file size limit before init', async t => {
  const root = await fixture()
  t.after(async () => { await rm(root, { recursive: true, force: true }) })
  const large = join(root, 'large.bin')
  await writeFile(large, 'x')
  await truncate(large, 20 * 1024 * 1024 + 1)
  const manager = new RepoManager({ subprocess: localSubprocess() }, { executable: 'git' })
  const preview = await manager.preview(root, '', new AbortController().signal)
  assert.equal(preview.status, 'blocked')
  assert.equal(preview.reason, 'file-size')
  assert.equal(preview.largestFile.path, 'large.bin')
})

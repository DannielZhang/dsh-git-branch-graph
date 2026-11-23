import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { GitBranchReader, parseGitLog, LIMITS } from '../git.js'

const H = 'a'.repeat(40)
const P = 'b'.repeat(40)
const R = 'c'.repeat(40)

test('git log parser keeps parents, refs, HEAD and subjects', () => {
  const commits = parseGitLog(`${H}\x1f${P} ${R}\x1fHEAD -> main, origin/main, tag: v1.0\x1f2026-11-23T12:00:00+08:00\x1fTester\x1fMerge feature\n`)
  assert.equal(commits.length, 1)
  assert.deepEqual(commits[0].parents, [P, R])
  assert.deepEqual(commits[0].refs, ['main', 'origin/main', 'tag: v1.0'])
  assert.equal(commits[0].head, true)
  assert.equal(commits[0].subject, 'Merge feature')
  assert.equal(LIMITS.MAX_COMMITS, 80)
})

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

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Graph Test', GIT_AUTHOR_EMAIL: 'graph@example.invalid',
      GIT_COMMITTER_NAME: 'Graph Test', GIT_COMMITTER_EMAIL: 'graph@example.invalid',
    },
  })
}

test('reader reports an initialized repository with no commits', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-git-empty-'))
  t.after(async () => { await rm(directory, { recursive: true, force: true }) })
  git(directory, ['init', '-b', 'main'])
  const reader = new GitBranchReader({ subprocess: localSubprocess() }, { executable: 'git' })
  const graph = await reader.read(directory, new AbortController().signal)
  assert.equal(graph.status, 'empty')
  assert.equal(graph.currentBranch, 'main')
  assert.deepEqual(graph.commits, [])
})

test('reader loads a real repository containing a branch and merge', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-git-branch-graph-'))
  t.after(async () => { await rm(directory, { recursive: true, force: true }) })
  git(directory, ['init', '-b', 'main'])
  await writeFile(join(directory, 'file.txt'), 'one\n')
  git(directory, ['add', 'file.txt'])
  git(directory, ['commit', '-m', 'Initial commit'])
  git(directory, ['checkout', '-b', 'feature'])
  await writeFile(join(directory, 'feature.txt'), 'feature\n')
  git(directory, ['add', 'feature.txt'])
  git(directory, ['commit', '-m', 'Add feature'])
  git(directory, ['checkout', 'main'])
  await writeFile(join(directory, 'main.txt'), 'main\n')
  git(directory, ['add', 'main.txt'])
  git(directory, ['commit', '-m', 'Advance main'])
  git(directory, ['merge', '--no-ff', 'feature', '-m', 'Merge feature'])

  const reader = new GitBranchReader({ subprocess: localSubprocess() }, { executable: 'git' })
  const graph = await reader.read(directory, new AbortController().signal)
  assert.equal(graph.status, 'ok')
  assert.equal(graph.currentBranch, 'main')
  assert.equal(graph.projectName, directory.split('/').at(-1))
  assert.ok(graph.commits.length >= 4)
  const merge = graph.commits.find(commit => commit.subject === 'Merge feature')
  assert.equal(merge.parents.length, 2)
  assert.equal(merge.head, true)
  assert.ok(merge.refs.includes('main'))
  assert.ok(graph.commits.some(commit => commit.refs.includes('feature')))
})

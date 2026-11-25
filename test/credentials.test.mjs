import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CredentialVault, parseGhHosts, parseGitCredentials,
} from '../credentials.js'

function emptySubprocess() {
  return {
    async resolveExecutable() { return 'git' },
    spawn() {
      return {
        collected: {
          stdout: { readFrom: () => ({ text: '', lossy: false }) },
          stderr: { readFrom: () => ({ text: '', lossy: false }) },
        },
        done: Promise.resolve({ exitCode: 1, signal: null }),
      }
    },
  }
}

test('parses multiple accounts from the Git credential store', () => {
  const entries = parseGitCredentials([
    'https://alice:token-a@github.com',
    'https://bob:token%2Db@github.com',
    'https://gitee-user:gitee-token@gitee.com',
  ].join('\n'), 'github')
  assert.deepEqual(entries.map(entry => entry.account), ['alice', 'bob'])
  assert.equal(entries[0].secret, 'token-a')
  assert.equal(entries[1].secret, 'token-b')
  assert.equal(entries[0].source, 'git-credentials')
})

test('parses GitHub CLI host accounts', () => {
  const entries = parseGhHosts([
    'github.com:',
    '    user: octocat',
    '    oauth_token: gho_example',
    'gitee.com:',
    '    user: other',
    '    oauth_token: gitee_example',
  ].join('\n'))
  assert.deepEqual(entries, [{
    provider: 'github', account: 'octocat', secret: 'gho_example', source: 'gh-cli',
  }])
})

test('vault lists metadata, auto-dedupes, and keeps secrets host-side', async t => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-gbr-credentials-'))
  t.after(async () => { await rm(home, { recursive: true, force: true }) })
  await writeFile(join(home, '.git-credentials'), [
    'https://alice:token-a@github.com',
    'https://bob:token-b@github.com',
    'https://gitee-user:gitee-token@gitee.com',
  ].join('\n'))
  await mkdir(join(home, '.config', 'gh'), { recursive: true })
  await writeFile(join(home, '.config', 'gh', 'hosts.yml'), [
    'github.com:',
    '    user: octocat',
    '    oauth_token: gho_example',
  ].join('\n'))

  const vault = new CredentialVault(
    { subprocess: emptySubprocess() },
    { home, env: { GITEE_TOKEN: 'env-gitee' }, executable: 'git' },
  )
  const github = await vault.list('github', new AbortController().signal)
  assert.deepEqual(github.map(entry => entry.account), ['octocat', 'alice', 'bob'])
  assert.equal(JSON.stringify(github).includes('gho_example'), false)
  assert.equal(JSON.stringify(github).includes('token-a'), false)
  assert.equal(vault.get(github[1].id, 'github').secret, 'token-a')
  assert.equal(vault.get(github[1].id, 'gitee'), undefined)

  const gitee = await vault.list('gitee', new AbortController().signal)
  assert.deepEqual(gitee.map(entry => entry.account), ['default', 'gitee-user'])
  assert.equal(JSON.stringify(gitee).includes('gitee-token'), false)
  assert.equal(vault.get(gitee[0].id, 'gitee').secret, 'env-gitee')

  const refreshed = await vault.list('github', new AbortController().signal, true)
  assert.notEqual(refreshed[0].id, github[0].id)

  vault.clear()
  assert.equal(vault.get(refreshed[0].id, 'github'), undefined)
})

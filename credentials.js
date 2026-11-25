/** Discover local Git hosting credentials without sending tokens to the browser. */

import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { resolveGitExecutable } from './git.js'

const HOSTS = { github: 'github.com', gitee: 'gitee.com' }
const SOURCE_PRIORITY = { environment: 0, 'gh-cli': 1, helper: 2, 'git-credentials': 3 }

function decode(value) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function unquote(value) {
  const trimmed = value.trim()
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

/** Parse the plain-text Git credential store, keeping only supported hosts. */
export function parseGitCredentials(text, provider) {
  const host = HOSTS[provider]
  if (host === undefined) return []
  const found = []
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue
    try {
      const parsed = new URL(line.trim())
      if (parsed.hostname !== host || parsed.password === '') continue
      found.push({
        provider,
        account: decode(parsed.username) || 'default',
        secret: decode(parsed.password),
        source: 'git-credentials',
      })
    } catch {
      // Ignore malformed or non-URL entries in the credential file.
    }
  }
  return found
}

/** Parse one host block from GitHub CLI's hosts.yml without exposing the token in metadata. */
export function parseGhHosts(text) {
  const found = []
  let currentHost = null
  let user = ''
  let token = ''
  const flush = () => {
    if (currentHost === 'github.com' && token !== '' && !token.startsWith('!')) {
      found.push({ provider: 'github', account: user || 'default', secret: token, source: 'gh-cli' })
    }
    user = ''
    token = ''
  }
  for (const line of text.split(/\r?\n/)) {
    const host = /^([^\s:#][^:]*):\s*$/.exec(line)
    if (host !== null && !line.startsWith(' ')) {
      flush()
      currentHost = host[1].trim()
      continue
    }
    const userMatch = /^\s+user:\s*(.*)$/.exec(line)
    if (userMatch !== null) user = unquote(userMatch[1])
    const tokenMatch = /^\s+oauth_token:\s*(.*)$/.exec(line)
    if (tokenMatch !== null) token = unquote(tokenMatch[1])
  }
  flush()
  return found
}

function parseCredentialOutput(output, provider) {
  const fields = {}
  for (const line of output.split(/\r?\n/)) {
    const index = line.indexOf('=')
    if (index <= 0) continue
    fields[line.slice(0, index)] = line.slice(index + 1)
  }
  if (typeof fields.password !== 'string' || fields.password === '') return null
  return {
    provider,
    account: fields.username || 'default',
    secret: fields.password,
    source: 'helper',
  }
}

export class CredentialVault {
  constructor(ctx, options = {}) {
    this.ctx = ctx
    this.home = options.home ?? homedir()
    this.env = options.env ?? process.env
    this.executablePromise = options.executable === undefined ? undefined : Promise.resolve(options.executable)
    this.cache = new Map()
    this.byId = new Map()
  }

  async executable(signal) {
    this.executablePromise ??= resolveGitExecutable(this.ctx, signal)
    return this.executablePromise
  }

  async credentialHelper(provider, signal) {
    const executable = await this.executable(signal)
    if (executable === null) return null
    const timeout = AbortSignal.timeout(8_000)
    const combined = AbortSignal.any([signal, timeout])
    const handle = this.ctx.subprocess.spawn({
      argv: [executable, 'credential', 'fill'],
      cwd: this.home,
      stdio: {
        stdin: { data: `protocol=https\nhost=${HOSTS[provider]}\n\n` },
        stdout: { maxBytes: 16 * 1024 },
        stderr: { maxBytes: 4 * 1024 },
      },
      env: {
        GIT_TERMINAL_PROMPT: '0',
        GIT_ASKPASS: '/usr/bin/false',
        SSH_ASKPASS: '/usr/bin/false',
        GCM_INTERACTIVE: 'never',
        LC_ALL: 'C',
      },
      graceMs: 500,
      signal: combined,
    })
    let outcome
    try {
      outcome = await handle.done
    } catch {
      return null
    }
    if (combined.aborted || outcome.exitCode !== 0) return null
    const output = handle.collected.stdout?.readFrom(0)?.text ?? ''
    return parseCredentialOutput(output, provider)
  }

  async gitCredentialsFile(provider) {
    try {
      const text = await readFile(join(this.home, '.git-credentials'), 'utf8')
      if (text.length > 256 * 1024) return []
      return parseGitCredentials(text, provider)
    } catch {
      return []
    }
  }

  async ghFile(provider) {
    if (provider !== 'github') return []
    try {
      const text = await readFile(join(this.home, '.config', 'gh', 'hosts.yml'), 'utf8')
      if (text.length > 256 * 1024) return []
      return parseGhHosts(text)
    } catch {
      return []
    }
  }

  environment(provider) {
    const found = []
    if (provider === 'github') {
      for (const key of ['GH_TOKEN', 'GITHUB_TOKEN']) {
        const token = this.env[key]
        if (typeof token === 'string' && token.trim() !== '') {
          found.push({ provider, account: this.env.GH_USER || 'default', secret: token.trim(), source: 'environment' })
        }
      }
    } else {
      for (const key of ['GITEE_TOKEN', 'GITEE_ACCESS_TOKEN']) {
        const token = this.env[key]
        if (typeof token === 'string' && token.trim() !== '') {
          found.push({ provider, account: this.env.GITEE_USER || 'default', secret: token.trim(), source: 'environment' })
        }
      }
    }
    return found
  }

  async discover(provider, signal) {
    const results = await Promise.allSettled([
      Promise.resolve(this.environment(provider)),
      this.ghFile(provider),
      this.credentialHelper(provider, signal),
      this.gitCredentialsFile(provider),
    ])
    const all = results.flatMap(result => result.status === 'fulfilled' && result.value !== null
      ? Array.isArray(result.value) ? result.value : [result.value]
      : [])
    const unique = new Map()
    for (const entry of all) {
      const account = String(entry.account || 'default').slice(0, 200)
      const secret = String(entry.secret || '')
      if (secret === '') continue
      const key = `${provider}\u0000${account.toLowerCase()}\u0000${secret}`
      if (!unique.has(key)) unique.set(key, { ...entry, account })
    }
    const entries = [...unique.values()]
      .sort((left, right) => (SOURCE_PRIORITY[left.source] ?? 9) - (SOURCE_PRIORITY[right.source] ?? 9)
        || left.account.localeCompare(right.account))
      .map(entry => ({ ...entry, id: randomUUID() }))
    for (const [id, entry] of this.byId) {
      if (entry.provider === provider && !entries.some(next => next.id === id)) this.byId.delete(id)
    }
    for (const entry of entries) this.byId.set(entry.id, entry)
    this.cache.set(provider, entries)
    return entries
  }

  async list(provider, signal, refresh = false) {
    if (HOSTS[provider] === undefined) return []
    if (!refresh && this.cache.has(provider)) {
      return this.cache.get(provider).map(entry => ({ id: entry.id, account: entry.account, source: entry.source }))
    }
    const entries = await this.discover(provider, signal)
    return entries.map(entry => ({ id: entry.id, account: entry.account, source: entry.source }))
  }

  get(id, provider) {
    const entry = this.byId.get(id)
    return entry?.provider === provider ? entry : undefined
  }

  clear() {
    this.cache.clear()
    this.byId.clear()
  }
}

export const __test = { parseCredentialOutput, HOSTS }

/** Parse SSH invocations and read-only remote Git projects. */

const SSH_OPTIONS_WITH_VALUE = new Set([
  '-b', '-c', '-D', '-E', '-e', '-F', '-I', '-i', '-J', '-L', '-l', '-m',
  '-O', '-o', '-P', '-p', '-Q', '-R', '-S', '-W', '-w',
])
const SSH_OPTIONS_FLAG = new Set([
  '-4', '-6', '-A', '-a', '-C', '-f', '-G', '-g', '-K', '-k', '-N', '-n',
  '-q', '-s', '-T', '-t', '-V', '-v', '-X', '-x', '-Y', '-y',
])
const REMOTE_ROOTS = /^\/(?:home|opt|srv|root|data|mnt|var\/www)\//
const PROJECT_DIR_NAMES = new Set([
  'bin', 'lib', 'lib64', 'include', 'share', 'node_modules', 'site-packages',
  'dist', 'build', 'build-new', '.git', '__pycache__', 'vllm_env', 'venv', '.venv',
])
const MAX_REMOTE_PATHS = 12
const HOST_RE = /^[a-zA-Z0-9._:[\]-]+$/
const USER_RE = /^[a-zA-Z0-9._-]+$/

export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

function expandVariables(value, vars) {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (whole, braced, plain) => vars[braced ?? plain] ?? whole)
}

function tokenizeShell(text) {
  const tokens = []
  let current = ''
  let quote = ''
  let escaped = false
  for (const char of text) {
    if (escaped) {
      current += char
      escaped = false
      continue
    }
    if (char === '\\' && quote !== "'") {
      escaped = true
      continue
    }
    if (quote !== '') {
      if (char === quote) quote = ''
      else current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (/\s/.test(char)) {
      if (current !== '') {
        tokens.push(current)
        current = ''
      }
      continue
    }
    if (char === ';' || char === '&' || char === '|') {
      if (current !== '') {
        tokens.push(current)
        current = ''
      }
      tokens.push(char)
      continue
    }
    current += char
  }
  if (current !== '') tokens.push(current)
  return tokens
}

function parseJumpList(value) {
  if (value === '') return []
  const hops = []
  for (const raw of value.split(',')) {
    const part = raw.trim()
    if (part === '' || part.startsWith('-')) return null
    let hostPart = part
    let user = null
    const at = part.lastIndexOf('@')
    if (at >= 0) {
      user = part.slice(0, at)
      hostPart = part.slice(at + 1)
      if (user === '' || !USER_RE.test(user)) return null
    }
    let host = hostPart
    let port = 22
    if (hostPart.startsWith('[')) {
      const close = hostPart.indexOf(']')
      if (close < 0) return null
      host = hostPart.slice(1, close)
      const rest = hostPart.slice(close + 1)
      if (rest !== '') {
        if (!rest.startsWith(':')) return null
        port = Number.parseInt(rest.slice(1), 10)
      }
    } else if ((hostPart.match(/:/g) ?? []).length === 1) {
      const index = hostPart.lastIndexOf(':')
      host = hostPart.slice(0, index)
      port = Number.parseInt(hostPart.slice(index + 1), 10)
    }
    if (!HOST_RE.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) return null
    hops.push(`${user === null ? '' : `${user}@`}${host}${port === 22 ? '' : `:${port}`}`)
  }
  return hops
}

function parseDestination(destination, userOption) {
  if (typeof destination !== 'string' || destination === '') return null
  let user = userOption ?? null
  let host = destination
  const at = destination.lastIndexOf('@')
  if (at > 0) {
    user = destination.slice(0, at)
    host = destination.slice(at + 1)
  }
  if (host.startsWith('[') && host.includes(']')) host = host.slice(1, host.indexOf(']'))
  if (!HOST_RE.test(host) || host.startsWith('-')) return null
  if (user !== null && !USER_RE.test(user)) return null
  return { host, user }
}

/** Extract safe SSH connection fields from commands or wrapper scripts. */
export function parseSshInvocations(text, variables = {}) {
  const tokens = tokenizeShell(text)
  const found = []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token !== 'ssh' && !token.endsWith('/ssh')) continue
    let key = null
    let port = null
    let userOption = null
    let destination = null
    let jumps = []
    let invalidJump = false
    const remote = []
    for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
      const part = tokens[cursor]
      if (part === ';' || part === '&' || part === '|') break
      if (destination === null) {
        if (part.startsWith('-') && part !== '-') {
          const option = part.split('=')[0]
          if (SSH_OPTIONS_WITH_VALUE.has(option)) {
            const value = part.includes('=') ? part.slice(part.indexOf('=') + 1) : tokens[++cursor]
            if (option === '-i') key = expandVariables(value ?? '', variables)
            else if (option === '-p') port = expandVariables(value ?? '', variables)
            else if (option === '-l') userOption = expandVariables(value ?? '', variables)
            else if (option === '-J') {
              const parsed = parseJumpList(expandVariables(value ?? '', variables))
              if (parsed === null) invalidJump = true
              else jumps = parsed
            }
          } else if (!SSH_OPTIONS_FLAG.has(option) && option.startsWith('--')) {
            if (!part.includes('=')) cursor += 1
          }
          continue
        }
        destination = expandVariables(part, variables)
        continue
      }
      remote.push(expandVariables(part, variables))
    }
    if (invalidJump) continue
    const target = parseDestination(destination, userOption && expandVariables(userOption, variables))
    if (target === null) continue
    if (!destination.includes('@') && !target.host.includes('.') && target.host !== 'localhost') continue
    const numericPort = port === null ? 22 : Number.parseInt(port, 10)
    if (!Number.isInteger(numericPort) || numericPort < 1 || numericPort > 65535) continue
    if (key !== null && (key === '' || key.includes('\0') || !key.startsWith('/'))) continue
    found.push({
      host: target.host,
      user: target.user,
      port: numericPort,
      key,
      jumps,
      remoteCommand: remote.join(' '),
    })
  }
  return found
}

/** Parse KEY="..." style assignments and the first safe SSH invocation in a wrapper. */
export function parseWrapperScript(text) {
  const variables = {}
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)=(?:"([^"]*)"|'([^']*)'|(\S+))\s*$/.exec(line)
    if (match !== null) variables[match[1]] = match[2] ?? match[3] ?? match[4] ?? ''
  }
  return parseSshInvocations(text, variables)
}

export function extractScriptReferences(text) {
  const seen = new Set()
  const scripts = []
  for (const match of text.matchAll(/(?:^|[\s"'`=(])((?:\.{0,2}\/)?[^\s"'`;&|()]+\.sh)\b/g)) {
    const value = match[1]
    if (value.startsWith('/home/') || value.startsWith('/opt/')) continue
    if (!seen.has(value)) {
      seen.add(value)
      scripts.push(value)
    }
  }
  return scripts
}

function remotePathPrefixes(path) {
  const parts = path.split('/').filter(Boolean)
  const root = parts[0]
  const prefixes = []
  const add = (depth) => {
    if (parts.length < depth) return
    const last = parts[depth - 1]
    if (last === undefined || last === '' || PROJECT_DIR_NAMES.has(last) || last.includes('*')) return
    if (/\.(?:js|ts|mjs|cjs|py|json|md|txt|log|sh|so|whl|gguf|bin|yaml|yml|toml|lock|zip|tar|gz)$/i.test(last)) return
    prefixes.push(`/${parts.slice(0, depth).join('/')}`)
  }
  if (root === 'home') {
    add(3)
    add(4)
  } else if (root === 'opt' || root === 'srv' || root === 'root' || root === 'data') {
    add(2)
    add(3)
  } else if (root === 'mnt') {
    add(3)
    add(4)
  } else if (root === 'var' && parts[1] === 'www') {
    add(3)
    add(4)
  }
  return prefixes
}

/** Absolute directories explicitly entered or addressed by Git in a command. */
export function extractExplicitRemotePaths(text) {
  const found = []
  const seen = new Set()
  for (const match of text.matchAll(/\b(?:cd|pushd|git\s+-C)\s+((?:"[^"]+"|'[^']+'|[^\s;&|]+))/g)) {
    const value = match[1].replace(/^['"]|['"]$/g, '').replace(/\\/g, '')
    if (!REMOTE_ROOTS.test(value) || value.includes('$') || value.includes('*')) continue
    if (!seen.has(value)) {
      seen.add(value)
      found.push(value)
    }
    if (found.length >= 4) break
  }
  return found
}

/** Derive bounded, directory-shaped remote project candidates from a command. */
export function extractRemotePaths(text) {
  const ordered = []
  const seen = new Set()
  const explicit = /\b(?:cd|pushd|git\s+-C)\s+((?:"[^"]+"|'[^']+'|[^\s;&|]+))/g
  for (const match of text.matchAll(explicit)) {
    const value = match[1].replace(/^['"]|['"]$/g, '').replace(/\\/g, '')
    if (!REMOTE_ROOTS.test(value)) continue
    for (const candidate of remotePathPrefixes(value)) {
      if (!seen.has(candidate)) {
        seen.add(candidate)
        ordered.push(candidate)
      }
    }
  }
  for (const match of text.matchAll(/\/(?:home|opt|srv|root|data|var\/www)\/[^\s"'`;&|)]*/g)) {
    const value = match[0].replace(/[),.;:!?]+$/, '')
    for (const candidate of remotePathPrefixes(value)) {
      if (!seen.has(candidate)) {
        seen.add(candidate)
        ordered.push(candidate)
      }
      if (ordered.length >= MAX_REMOTE_PATHS * 2) break
    }
    if (ordered.length >= MAX_REMOTE_PATHS * 2) break
  }
  return ordered.slice(0, MAX_REMOTE_PATHS)
}

function hash(value) {
  let result = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index)
    result = Math.imul(result, 16777619)
  }
  return (result >>> 0).toString(36)
}

export function remoteProjectId(connection, path) {
  return `remote-${hash(`${connection.user ?? ''}@${connection.host}:${connection.port}\0${path}`)}`
}

export function remoteLabel(path) {
  const parts = path.split('/').filter(Boolean)
  return parts.at(-1) ?? path
}

export class RemoteRegistry {
  constructor() {
    this.projects = new Map()
  }

  set(id, project) {
    this.projects.set(id, project)
  }

  get(id) {
    return this.projects.get(id)
  }

  clear() {
    this.projects.clear()
  }
}

export const __test = {
  tokenizeShell, remotePathPrefixes, hash, parseDestination,
}

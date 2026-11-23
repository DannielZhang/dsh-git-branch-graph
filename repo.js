/** Safe Git initialization, first commit, remote creation, and push operations. */

import { appendFile, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { resolveGitExecutable } from './git.js'

export const REPO_LIMITS = Object.freeze({
  maxFiles: 5_000,
  maxFileBytes: 20 * 1024 * 1024,
  maxTotalBytes: 100 * 1024 * 1024,
  previewMaxBytes: 8 * 1024 * 1024,
  sampleFiles: 20,
})

const PREVIEW_TIMEOUT_MS = 25_000
const ACTION_TIMEOUT_MS = 120_000
const PUSH_TIMEOUT_MS = 120_000
const STDERR_MAX_BYTES = 32 * 1024
const SAFETY_MARKER = '# Added by dsh-git-branch-graph: keep secrets and dependencies out of commits.'
const SAFETY_EXCLUDES = `${SAFETY_MARKER}
.env
.env.*
.env/
.env.*/
!.env.example
.envrc
.npmrc
.pypirc
.netrc
.git-credentials
.aws/
.ssh/
.kube/
.docker/
.gnupg/
credentials.json
auth.json
secrets.json
secrets.yaml
secrets.yml
*.secret
*.secrets
*.pem
*.key
*.p12
*.pfx
id_rsa
id_ed25519
.DS_Store
Thumbs.db
node_modules/
bower_components/
.venv/
venv/
__pycache__/
.pytest_cache/
.mypy_cache/
.cache/
.turbo/
*.log
`
const BASE_GITIGNORE = `# Created by dsh-git-branch-graph
.DS_Store
Thumbs.db
node_modules/
.venv/
venv/
__pycache__/
dist/
build/
*.log
.env
.env.*
!.env.example
`
const SCP_REMOTE = /^([^@\s:]+)@([^:\s]+):(\S+)$/
const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/
const REMOTE_SEGMENT = /^[A-Za-z0-9._-]+$/

export class RepoActionError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'RepoActionError'
    this.code = code
    this.details = details
  }
}

export function validateRepoName(value) {
  if (typeof value !== 'string' || !REPO_NAME.test(value.trim())) {
    throw new RepoActionError('invalid-repo-name', 'Repository names use letters, digits, dots, underscores, or hyphens.')
  }
  return value.trim()
}

export function validateRemoteUrl(value) {
  if (typeof value !== 'string') throw new RepoActionError('invalid-remote-url', 'Enter a remote repository URL.')
  const remote = value.trim()
  if (remote === '' || remote.length > 2_000 || remote.includes('\0')) {
    throw new RepoActionError('invalid-remote-url', 'Enter a valid remote repository URL.')
  }
  if (SCP_REMOTE.test(remote)) return remote
  let parsed
  try {
    parsed = new URL(remote)
  } catch {
    throw new RepoActionError('invalid-remote-url', 'Enter an HTTPS or SSH remote repository URL.')
  }
  if (!['https:', 'ssh:'].includes(parsed.protocol)) {
    throw new RepoActionError('invalid-remote-url', 'Only HTTPS and SSH remote URLs are supported.')
  }
  if (parsed.password !== '') {
    throw new RepoActionError('invalid-remote-url', 'Do not embed credentials in the remote URL.')
  }
  if (parsed.protocol === 'https:' && parsed.username !== '') {
    throw new RepoActionError('invalid-remote-url', 'Do not embed credentials in the remote URL.')
  }
  if (parsed.search !== '' || parsed.hash !== '') {
    throw new RepoActionError('invalid-remote-url', 'Do not include query parameters or fragments in the remote URL.')
  }
  return remote
}

export function redactRemoteUrl(value) {
  if (SCP_REMOTE.test(value)) return value
  try {
    const parsed = new URL(value)
    parsed.username = ''
    parsed.password = ''
    for (const key of ['access_token', 'private_token', 'token', 'password', 'secret']) {
      if (parsed.searchParams.has(key)) parsed.searchParams.set(key, '[redacted]')
    }
    return parsed.toString()
  } catch {
    return value.replace(/\/\/[^/@\s]+@/, '//')
  }
}

/** Build a temporary Git config that authenticates one push without persisting the token. */
export function buildPushEnv(provider, token, hooksPath) {
  const entries = []
  if (typeof hooksPath === 'string' && hooksPath !== '') entries.push(['core.hooksPath', hooksPath])
  if (provider === 'github' || provider === 'gitee') {
    if (typeof token !== 'string' || token === '') {
      throw new RepoActionError('token-required', 'Enter a personal access token for the selected provider.')
    }
    const host = provider === 'github' ? 'github.com' : 'gitee.com'
    const username = provider === 'github' ? 'x-access-token' : 'oauth2'
    const header = `Authorization: Basic ${Buffer.from(`${username}:${token}`, 'utf8').toString('base64')}`
    entries.push([`http.https://${host}/.extraheader`, header])
  }
  const env = { GIT_CONFIG_COUNT: String(entries.length) }
  entries.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key
    env[`GIT_CONFIG_VALUE_${index}`] = value
  })
  return env
}

export function buildHooksEnv(hooksPath) {
  return buildPushEnv('none', '', hooksPath)
}

function cleanText(value) {
  return String(value).replace(/[\r\n]+/g, ' ').trim().slice(0, 500)
}

function cleanGitText(value) {
  return cleanText(value)
    .replace(/(https?:\/\/)[^\s/@]+@/gi, '$1')
    .replace(/([?&](?:access_token|private_token|token)=)[^&\s]+/gi, '$1[redacted]')
}

const UNSAFE_SEGMENTS = new Set([
  'node_modules', 'bower_components', '.venv', 'venv', '__pycache__',
  '.pytest_cache', '.mypy_cache', '.cache', '.turbo',
  '.aws', '.ssh', '.kube', '.docker', '.gnupg',
])
const UNSAFE_BASENAMES = new Set([
  '.ds_store', 'thumbs.db', 'id_rsa', 'id_ed25519', '.envrc', '.npmrc', '.pypirc', '.netrc',
  '.git-credentials', 'credentials.json', 'auth.json', 'secrets.json', 'secrets.yaml', 'secrets.yml',
])

/** Whether a staged path must never enter an automatic commit. */
export function isUnsafePath(path) {
  const parts = path.split('/').map(part => part.toLowerCase())
  const base = parts[parts.length - 1] ?? ''
  if (parts.some(part => UNSAFE_SEGMENTS.has(part))) return true
  if (parts.some(part => part === '.env' || part.startsWith('.env.'))) {
    return !(parts[parts.length - 1] === '.env.example' && parts.filter(part => part.startsWith('.env')).length === 1)
  }
  if (UNSAFE_BASENAMES.has(base)) return true
  return /\.(?:pem|key|p12|pfx|log|secret|secrets)$/i.test(base)
}

async function measureFiles(target, paths) {
  let totalBytes = 0
  let largest = null
  for (let index = 0; index < paths.length; index += 64) {
    const batch = paths.slice(index, index + 64)
    const stats = await Promise.all(batch.map(async (path) => {
      const absolute = join(target, ...path.split('/'))
      try {
        const info = await lstat(absolute)
        return info.isFile() || info.isSymbolicLink() ? { path, bytes: info.size } : null
      } catch {
        return null
      }
    }))
    for (const item of stats) {
      if (item === null) continue
      totalBytes += item.bytes
      if (largest === null || item.bytes > largest.bytes) largest = item
    }
  }
  return { totalBytes, largest }
}

async function canonicalDirectory(path) {
  const real = await realpath(path)
  const info = await stat(real)
  if (!info.isDirectory()) throw new RepoActionError('not-a-directory', 'The selected project path is not a directory.')
  return real
}

function posixRelative(base, target) {
  return relative(base, target).split(sep).join('/')
}

export async function resolveProjectPath(base, relativePath) {
  if (typeof relativePath !== 'string' || relativePath.length > 500 || relativePath.includes('\0') || isAbsolute(relativePath)) {
    throw new RepoActionError('invalid-path', 'Enter a project path relative to the current workspace.')
  }
  let root
  try {
    root = await canonicalDirectory(base)
  } catch (error) {
    if (error instanceof RepoActionError) throw error
    throw new RepoActionError('invalid-path', 'The current project directory is unavailable.')
  }
  const candidate = resolve(root, relativePath === '' ? '.' : relativePath)
  if (candidate !== root && !candidate.startsWith(root + sep)) {
    throw new RepoActionError('invalid-path', 'The project directory must stay inside the current workspace.')
  }
  let target
  try {
    target = await canonicalDirectory(candidate)
  } catch (error) {
    if (error instanceof RepoActionError) throw error
    throw new RepoActionError('directory-not-found', 'The selected project directory does not exist.')
  }
  if (target !== root && !target.startsWith(root + sep)) {
    throw new RepoActionError('invalid-path', 'The project directory must stay inside the current workspace.')
  }
  const segments = target === root ? [] : relative(root, target).split(sep)
  if (segments.some(segment => isUnsafePath(segment))) {
    throw new RepoActionError('unsafe-path', 'A protected directory cannot be used as the repository root.')
  }
  return { root, target }
}

function branchName(result) {
  return result.exitCode === 0 ? result.stdout.trim() : null
}

function remoteList(stdout) {
  const remotes = new Map()
  for (const line of stdout.split('\n')) {
    const match = /^(\S+)\t(\S+)(?: \((fetch|push)\))?$/.exec(line)
    if (match === null) continue
    const [, name, url] = match
    if (!remotes.has(name)) {
      let usable = true
      try {
        validateRemoteUrl(url)
      } catch {
        usable = false
      }
      remotes.set(name, { url: redactRemoteUrl(url), usable })
    }
  }
  return [...remotes].map(([name, value]) => ({ name, url: value.url, usable: value.usable }))
}

function parseNulPaths(stdout) {
  return stdout.split('\0').filter(path => path !== '')
}

export class RepoManager {
  constructor(ctx, options = {}) {
    this.ctx = ctx
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
    this.executablePromise = options.executable === undefined ? undefined : Promise.resolve(options.executable)
    this.busy = false
  }

  async executable(signal) {
    this.executablePromise ??= resolveGitExecutable(this.ctx, signal)
    const executable = await this.executablePromise
    if (executable === null) throw new RepoActionError('git-unavailable', 'Git is not available on this Host.')
    return executable
  }

  async run(executable, cwd, args, options = {}) {
    const signal = options.signal
    const timeout = AbortSignal.timeout(options.timeoutMs ?? ACTION_TIMEOUT_MS)
    const combined = AbortSignal.any([signal, timeout])
    let handle
    try {
      handle = this.ctx.subprocess.spawn({
        argv: [executable, ...args],
        cwd,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: options.maxBytes ?? REPO_LIMITS.previewMaxBytes },
          stderr: { maxBytes: STDERR_MAX_BYTES },
        },
        env: {
          GIT_CONFIG_COUNT: '0',
          GIT_TERMINAL_PROMPT: '0',
          GIT_OPTIONAL_LOCKS: '0',
          LC_ALL: 'C',
          ...options.env,
        },
        graceMs: 1_000,
        signal: combined,
      })
    } catch (error) {
      throw new RepoActionError('git-spawn-failed', `Could not start Git: ${cleanText(String(error))}`)
    }
    let outcome
    try {
      outcome = await handle.done
    } catch (error) {
      throw new RepoActionError('git-spawn-failed', `Could not run Git: ${cleanText(String(error))}`)
    }
    if (combined.aborted) {
      throw new RepoActionError(timeout.aborted ? 'git-timeout' : 'cancelled',
        timeout.aborted ? 'The Git operation timed out.' : 'The Git operation was cancelled.')
    }
    const stdout = handle.collected.stdout?.readFrom(0) ?? { text: '', lossy: false }
    const stderr = handle.collected.stderr?.readFrom(0)?.text ?? ''
    return { exitCode: outcome.exitCode, stdout: stdout.text, stderr, truncated: stdout.lossy }
  }

  async identity(executable, cwd, signal) {
    const read = async (key) => {
      const result = await this.run(executable, cwd, ['config', '--global', '--get', key], {
        signal, timeoutMs: 10_000, maxBytes: 4_096,
      })
      return result.exitCode === 0 ? result.stdout.trim() : null
    }
    return { name: await read('user.name'), email: await read('user.email') }
  }

  async assertNoGitEntry(target) {
    try {
      const info = await lstat(join(target, '.git'))
      if (info !== null) {
        throw new RepoActionError('unsafe-git-dir', 'A .git entry already exists but is not a usable repository.')
      }
    } catch (error) {
      if (error?.code === 'ENOENT') return
      if (error instanceof RepoActionError) throw error
      throw new RepoActionError('unsafe-git-dir', 'Could not verify the repository metadata path.')
    }
  }

  async validateGitDir(executable, root, base, signal) {
    try {
      const entry = await lstat(join(root, '.git'))
      if (entry.isSymbolicLink()) {
        throw new RepoActionError('unsafe-git-dir', 'The repository .git entry must not be a symbolic link.')
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        if (error instanceof RepoActionError) throw error
        throw new RepoActionError('unsafe-git-dir', 'Could not inspect the repository .git entry.')
      }
    }
    const found = await this.run(executable, root, ['rev-parse', '--absolute-git-dir'], { signal, maxBytes: 8_192 })
    if (found.exitCode !== 0) {
      throw new RepoActionError('unsafe-git-dir', 'Could not resolve the repository metadata directory.')
    }
    let gitDir
    try {
      gitDir = await realpath(found.stdout.trim())
    } catch {
      throw new RepoActionError('unsafe-git-dir', 'The repository metadata directory is unavailable.')
    }
    if (gitDir !== base && !gitDir.startsWith(base + sep)) {
      throw new RepoActionError('unsafe-git-dir', 'The repository metadata directory is outside the current workspace.')
    }
    for (const relativePath of ['objects', 'refs', 'hooks', 'logs', 'info', 'info/exclude', 'config']) {
      const path = join(gitDir, ...relativePath.split('/'))
      let info
      try {
        info = await lstat(path)
      } catch (error) {
        if (error?.code === 'ENOENT') continue
        throw new RepoActionError('unsafe-git-dir', 'Could not inspect the repository metadata files.')
      }
      if (info.isSymbolicLink()) {
        throw new RepoActionError('unsafe-git-dir', 'Repository metadata files must not be symbolic links.')
      }
      const canonical = await realpath(path)
      if (canonical !== gitDir && !canonical.startsWith(gitDir + sep)) {
        throw new RepoActionError('unsafe-git-dir', 'Repository metadata escapes its Git directory.')
      }
    }
    return gitDir
  }

  async workingSetPreview(executable, root, signal) {
    const staged = await this.run(executable, root, ['ls-files', '-z'], { signal, maxBytes: REPO_LIMITS.previewMaxBytes })
    const untracked = await this.run(executable, root, ['ls-files', '--others', '--exclude-standard', '-z'], {
      signal, maxBytes: REPO_LIMITS.previewMaxBytes,
    })
    if (staged.exitCode !== 0 || untracked.exitCode !== 0) {
      throw new RepoActionError('preview-failed', 'Could not scan the files for the first commit.')
    }
    const paths = [...new Set([...parseNulPaths(staged.stdout), ...parseNulPaths(untracked.stdout)])]
      .filter(path => !isUnsafePath(path))
    const { totalBytes, largest } = await measureFiles(root, paths)
    const identity = await this.identity(executable, root, signal)
    const hasGitignore = await stat(join(root, '.gitignore')).then(info => info.isFile()).catch(() => false)
    const base = {
      status: 'ok',
      fileCount: paths.length,
      totalBytes,
      largestFile: largest,
      sampleFiles: paths.slice(0, REPO_LIMITS.sampleFiles),
      hasGitignore,
      identity,
      limits: REPO_LIMITS,
    }
    if (staged.truncated || untracked.truncated) {
      return { ...base, status: 'blocked', reason: 'preview-limit', fileCount: null }
    }
    if (paths.length > REPO_LIMITS.maxFiles) return { ...base, status: 'blocked', reason: 'file-count' }
    if (largest !== null && largest.bytes > REPO_LIMITS.maxFileBytes) {
      return { ...base, status: 'blocked', reason: 'file-size' }
    }
    if (totalBytes > REPO_LIMITS.maxTotalBytes) return { ...base, status: 'blocked', reason: 'total-size' }
    return base
  }

  async existingPreview(executable, target, signal) {
    const rootResult = await this.run(executable, target, ['rev-parse', '--show-toplevel'], { signal, maxBytes: 8_192 })
    if (rootResult.exitCode !== 0) return null
    const root = rootResult.stdout.trim()
    if (root === '') return null
    const fetchUrlsResult = await this.run(executable, root, ['remote', 'get-url', '--all', 'origin'], { signal, maxBytes: 16 * 1024 })
    const pushUrlsResult = await this.run(executable, root, ['remote', 'get-url', '--push', '--all', 'origin'], { signal, maxBytes: 16 * 1024 })
    const fetchUrls = fetchUrlsResult.exitCode === 0 ? fetchUrlsResult.stdout.split('\n').filter(Boolean) : []
    const pushUrls = pushUrlsResult.exitCode === 0 ? pushUrlsResult.stdout.split('\n').filter(Boolean) : []
    const allOriginUrls = [...fetchUrls, ...pushUrls]
    let originUsable = pushUrls.length === 1 && allOriginUrls.every((url) => {
      try {
        validateRemoteUrl(url)
        return true
      } catch {
        return false
      }
    })
    if (fetchUrls.length === 0) originUsable = false
    const branch = branchName(await this.run(executable, root, ['symbolic-ref', '--short', '-q', 'HEAD'], { signal, maxBytes: 8_192 }))
    const head = await this.run(executable, root, ['rev-parse', '--verify', 'HEAD'], { signal, maxBytes: 8_192 })
    const hasCommit = head.exitCode === 0
    let commitCount = 0
    if (hasCommit) {
      const count = await this.run(executable, root, ['rev-list', '--count', 'HEAD'], { signal, maxBytes: 8_192 })
      if (count.exitCode === 0) commitCount = Number.parseInt(count.stdout.trim(), 10) || 0
    }
    const remotes = remoteList((await this.run(executable, root, ['remote', '-v'], { signal, maxBytes: 64 * 1024 })).stdout)
      .map(remote => remote.name === 'origin'
        ? {
          ...remote,
          url: fetchUrls[0] === undefined ? remote.url : redactRemoteUrl(fetchUrls[0]),
          pushUrl: pushUrls[0] === undefined ? null : redactRemoteUrl(pushUrls[0]),
          usable: originUsable,
        }
        : remote)
    const status = await this.run(executable, root, ['status', '--porcelain', '-z'], { signal, maxBytes: 256 * 1024 })
    const dirtyCount = hasCommit ? parseNulPaths(status.stdout).length : 0
    const base = {
      status: 'ok',
      isGit: true,
      target,
      root,
      relativePath: '.',
      projectName: basename(root),
      branch,
      hasCommit,
      commitCount,
      remotes,
      dirtyCount,
      dirtyTruncated: hasCommit ? status.truncated : false,
      limits: REPO_LIMITS,
    }
    if (!hasCommit) {
      const working = await this.workingSetPreview(executable, root, signal)
      return { ...base, ...working, hasCommit: false }
    }
    return base
  }

  async browse(sessionCwd, relativePath, signal) {
    const { root, target } = await resolveProjectPath(sessionCwd, relativePath)
    let entries
    try {
      entries = await readdir(target, { withFileTypes: true })
    } catch {
      throw new RepoActionError('directory-unreadable', 'This directory cannot be read.')
    }
    const directories = entries
      .filter(entry => entry.isDirectory() && entry.name !== '.git'
        && !entry.name.startsWith('.dsh-git-init-') && !isUnsafePath(entry.name))
      .map(entry => ({
        name: entry.name,
        path: posixRelative(root, join(target, entry.name)),
        hidden: entry.name.startsWith('.'),
      }))
      .sort((left, right) => Number(left.hidden) - Number(right.hidden)
        || left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }))
    const current = posixRelative(root, target)
    return {
      status: 'ok',
      current,
      parent: target === root ? null : posixRelative(root, dirname(target)) || '',
      directories: directories.slice(0, 500),
      truncated: directories.length > 500,
    }
  }

  async preview(sessionCwd, relativePath, signal) {
    const executable = await this.executable(signal)
    const { root, target } = await resolveProjectPath(sessionCwd, relativePath)
    const existing = await this.existingPreview(executable, target, signal)
    if (existing !== null) {
      if (existing.root !== root && !existing.root.startsWith(root + sep)) {
        throw new RepoActionError('invalid-path', 'The enclosing Git repository is outside the current workspace.')
      }
      await this.validateGitDir(executable, existing.root, root, signal)
      return existing
    }
    await this.assertNoGitEntry(target)

    const temp = await mkdtemp(join(tmpdir(), 'dsh-gbr-preview-'))
    try {
      const gitDir = join(temp, 'repo.git')
      const initialized = await this.run(executable, temp, ['init', '--bare', gitDir], {
        signal, timeoutMs: 15_000, maxBytes: 16 * 1024,
      })
      if (initialized.exitCode !== 0) throw new RepoActionError('preview-failed', 'Could not prepare the preview.')
      const excludes = join(temp, 'exclude')
      await writeFile(excludes, SAFETY_EXCLUDES)
      const listed = await this.run(executable, target, [
        '--git-dir', gitDir, '--work-tree', target,
        'ls-files', '--others', '--exclude-standard', '-z',
      ], {
        signal,
        timeoutMs: PREVIEW_TIMEOUT_MS,
        maxBytes: REPO_LIMITS.previewMaxBytes,
        env: {
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: 'core.excludesFile',
          GIT_CONFIG_VALUE_0: excludes,
          GIT_INDEX_FILE: join(temp, 'index'),
        },
      })
      if (listed.exitCode !== 0) {
        throw new RepoActionError('preview-failed', `Could not scan the project: ${cleanText(listed.stderr)}`)
      }
      const paths = parseNulPaths(listed.stdout).filter(path => !isUnsafePath(path))
      const sample = paths.slice(0, REPO_LIMITS.sampleFiles)
      const base = {
        target,
        relativePath: relative(root, target) || '.',
        projectName: basename(target),
        fileCount: paths.length,
        sampleFiles: sample,
        hasGitignore: await stat(join(target, '.gitignore')).then(info => info.isFile()).catch(() => false),
        limits: REPO_LIMITS,
      }
      if (listed.truncated) {
        return { ...base, status: 'blocked', reason: 'preview-limit', fileCount: null }
      }
      if (paths.length > REPO_LIMITS.maxFiles) {
        return { ...base, status: 'blocked', reason: 'file-count' }
      }

      const { totalBytes, largest } = await measureFiles(target, paths)
      const identity = await this.identity(executable, target, signal)
      const result = { ...base, isGit: false, totalBytes, largestFile: largest, identity }
      if (largest !== null && largest.bytes > REPO_LIMITS.maxFileBytes) {
        return { ...result, status: 'blocked', reason: 'file-size' }
      }
      if (totalBytes > REPO_LIMITS.maxTotalBytes) {
        return { ...result, status: 'blocked', reason: 'total-size' }
      }
      return { ...result, status: 'ok' }
    } finally {
      await rm(temp, { recursive: true, force: true })
    }
  }

  async ensureSafetyExcludes(gitDir) {
    const directory = join(gitDir, 'info')
    await mkdir(directory, { recursive: true })
    const path = join(directory, 'exclude')
    try {
      const info = await lstat(path)
      if (info.isSymbolicLink()) {
        throw new RepoActionError('unsafe-git-dir', 'The repository exclude file must not be a symbolic link.')
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        if (error instanceof RepoActionError) throw error
        throw new RepoActionError('unsafe-git-dir', 'Could not inspect the repository exclude file.')
      }
    }
    let current = ''
    try {
      current = await readFile(path, 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    if (!current.includes(SAFETY_MARKER)) {
      await appendFile(path, `${current === '' || current.endsWith('\n') ? '' : '\n'}${SAFETY_EXCLUDES}`)
    }
  }

  async ensureInitialCommit(executable, root, gitDir, input, signal, hooksEnv) {
    const identity = await this.identity(executable, root, signal)
    const name = input.authorName?.trim() || identity.name
    const email = input.authorEmail?.trim() || identity.email
    if (name === undefined || name === null || name === '' || email === undefined || email === null || email === '') {
      throw new RepoActionError('identity-required', 'Configure a Git author name and email before creating the first commit.')
    }
    if (name.length > 200 || email.length > 320 || /[\r\n\0]/.test(name) || /[\r\n\0]/.test(email)) {
      throw new RepoActionError('invalid-identity', 'The Git author name or email is invalid.')
    }
    if (!email.includes('@')) throw new RepoActionError('invalid-identity', 'Enter a valid Git author email.')

    await this.ensureSafetyExcludes(gitDir)
    if (input.createGitignore === true) {
      try {
        await writeFile(join(root, '.gitignore'), BASE_GITIGNORE, { flag: 'wx' })
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error
      }
    }
    const configuredName = await this.run(executable, root, ['config', 'user.name', name], { signal, maxBytes: 8_192 })
    if (configuredName.exitCode !== 0) throw new RepoActionError('identity-failed', 'Could not configure the Git author name.')
    const configuredEmail = await this.run(executable, root, ['config', 'user.email', email], { signal, maxBytes: 8_192 })
    if (configuredEmail.exitCode !== 0) throw new RepoActionError('identity-failed', 'Could not configure the Git author email.')

    const added = await this.run(executable, root, ['add', '-A'], {
      signal, timeoutMs: ACTION_TIMEOUT_MS, maxBytes: 1024 * 1024,
    })
    if (added.exitCode !== 0) throw new RepoActionError('stage-failed', `Could not stage files: ${cleanGitText(added.stderr)}`)
    const staged = await this.run(executable, root, ['ls-files', '-z'], {
      signal, maxBytes: 4 * 1024 * 1024,
    })
    let stagedPaths = parseNulPaths(staged.stdout)
    if (staged.truncated || stagedPaths.length > REPO_LIMITS.maxFiles) {
      await this.run(executable, root, ['reset'], { signal, maxBytes: 8_192 })
      throw new RepoActionError('blocked', 'The staged change set exceeds the safety limit.', {
        reason: 'file-count', fileCount: stagedPaths.length, limits: REPO_LIMITS,
      })
    }
    const unsafe = stagedPaths.filter(isUnsafePath)
    if (unsafe.length > 0) {
      if (unsafe.length > 500) {
        await this.run(executable, root, ['reset'], { signal, maxBytes: 8_192 })
        throw new RepoActionError('unsafe-files', 'Protected files were staged and could not be excluded safely.', {
          files: unsafe.slice(0, 20),
        })
      }
      for (let index = 0; index < unsafe.length; index += 100) {
        const batch = unsafe.slice(index, index + 100)
        const reset = await this.run(executable, root, ['reset', '-q', '--', ...batch], {
          signal, maxBytes: 8_192, env: { ...hooksEnv, GIT_LITERAL_PATHSPECS: '1' },
        })
        if (reset.exitCode !== 0) {
          await this.run(executable, root, ['reset'], { signal, maxBytes: 8_192 })
          throw new RepoActionError('unsafe-files', 'Protected files could not be removed from the first commit.', {
            files: unsafe.slice(0, 20),
          })
        }
      }
      const remaining = await this.run(executable, root, ['ls-files', '-z'], {
        signal, maxBytes: 4 * 1024 * 1024,
      })
      stagedPaths = parseNulPaths(remaining.stdout)
      if (remaining.truncated || stagedPaths.some(isUnsafePath)) {
        await this.run(executable, root, ['reset'], { signal, maxBytes: 8_192 })
        throw new RepoActionError('unsafe-files', 'Protected files remain staged; refusing to commit.', {
          files: stagedPaths.filter(isUnsafePath).slice(0, 20),
        })
      }
    }
    if (stagedPaths.length === 0) {
      throw new RepoActionError('no-files', 'There are no files to commit after applying the safety excludes.')
    }
    const stagedSize = await measureFiles(root, stagedPaths)
    if (stagedSize.largest !== null && stagedSize.largest.bytes > REPO_LIMITS.maxFileBytes) {
      await this.run(executable, root, ['reset'], { signal, maxBytes: 8_192 })
      throw new RepoActionError('blocked', 'A staged file exceeds the safety limit.', {
        reason: 'file-size', largestFile: stagedSize.largest, limits: REPO_LIMITS,
      })
    }
    if (stagedSize.totalBytes > REPO_LIMITS.maxTotalBytes) {
      await this.run(executable, root, ['reset'], { signal, maxBytes: 8_192 })
      throw new RepoActionError('blocked', 'The staged change set exceeds the total size limit.', {
        reason: 'total-size', totalBytes: stagedSize.totalBytes, limits: REPO_LIMITS,
      })
    }
    const committed = await this.run(executable, root, ['commit', '--no-gpg-sign', '--no-verify', '-m', 'Initial commit'], {
      signal, timeoutMs: ACTION_TIMEOUT_MS, maxBytes: 1024 * 1024, env: hooksEnv,
    })
    if (committed.exitCode !== 0) {
      throw new RepoActionError('commit-failed', `Could not create the first commit: ${cleanGitText(committed.stderr)}`)
    }
    return { name, email }
  }

  async effectivePushUrl(executable, root, signal) {
    const result = await this.run(executable, root, ['remote', 'get-url', '--push', '--all', 'origin'], {
      signal, maxBytes: 16 * 1024,
    })
    const urls = result.exitCode === 0 ? result.stdout.split('\n').filter(Boolean) : []
    if (urls.length !== 1) {
      throw new RepoActionError('remote-redirect', 'The repository must resolve to exactly one push URL.')
    }
    return validateRemoteUrl(urls[0])
  }

  async configureOrigin(executable, root, remoteUrl, signal) {
    const current = await this.run(executable, root, ['remote', 'get-url', 'origin'], { signal, maxBytes: 8_192 })
    const args = current.exitCode === 0
      ? ['remote', 'set-url', 'origin', remoteUrl]
      : ['remote', 'add', 'origin', remoteUrl]
    const changed = await this.run(executable, root, args, { signal, maxBytes: 8_192 })
    if (changed.exitCode !== 0) {
      throw new RepoActionError('remote-config-failed', 'Could not configure the origin remote.')
    }
    const pushUrls = await this.run(executable, root, ['config', '--get-all', 'remote.origin.pushurl'], { signal, maxBytes: 16 * 1024 })
    if (pushUrls.exitCode === 0 && pushUrls.stdout.trim() !== '') {
      const cleared = await this.run(executable, root, ['config', '--unset-all', 'remote.origin.pushurl'], {
        signal, maxBytes: 8_192,
      })
      if (cleared.exitCode !== 0) {
        throw new RepoActionError('remote-config-failed', 'Could not clear stale push URLs from origin.')
      }
    }
    const effective = await this.effectivePushUrl(executable, root, signal)
    if (effective !== remoteUrl) {
      throw new RepoActionError('remote-redirect', 'Git configuration would redirect the configured push URL.')
    }
  }

  async push(executable, root, provider, token, remoteUrl, hooksPath, signal) {
    const effective = await this.effectivePushUrl(executable, root, signal)
    if (effective !== remoteUrl) {
      throw new RepoActionError('remote-redirect', 'Git configuration would redirect the push URL.', {
        remoteUrl: redactRemoteUrl(remoteUrl),
      })
    }
    const env = buildPushEnv(provider, token, hooksPath)
    const pushed = await this.run(executable, root, ['push', '--no-verify', '-u', 'origin', 'HEAD'], {
      signal,
      timeoutMs: PUSH_TIMEOUT_MS,
      maxBytes: 2 * 1024 * 1024,
      env,
    })
    if (pushed.exitCode !== 0) {
      throw new RepoActionError('push-failed', `Push failed: ${cleanGitText(pushed.stderr) || 'Git exited with an error.'}`, {
        remoteUrl: redactRemoteUrl(remoteUrl),
      })
    }
    return true
  }

  async createRemote(provider, token, repoName, isPrivate, signal) {
    if (typeof token !== 'string' || token.trim() === '' || token.length > 1_000) {
      throw new RepoActionError('token-required', 'Enter a personal access token for the selected provider.')
    }
    if (typeof this.fetchImpl !== 'function') {
      throw new RepoActionError('network-unavailable', 'This Host cannot create remote repositories.')
    }
    const name = validateRepoName(repoName)
    const isGitHub = provider === 'github'
    const endpoint = isGitHub ? 'https://api.github.com/user/repos' : 'https://gitee.com/api/v5/user/repos'
    const timeout = AbortSignal.timeout(20_000)
    const combined = AbortSignal.any([signal, timeout])
    let response
    try {
      response = await this.fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `token ${token.trim()}`,
          Accept: isGitHub ? 'application/vnd.github+json' : 'application/json',
          'Content-Type': 'application/json',
          'User-Agent': 'dsh-git-branch-graph',
          ...(isGitHub ? { 'X-GitHub-Api-Version': '2022-11-28' } : {}),
        },
        body: JSON.stringify({
          name,
          private: isPrivate === true,
          auto_init: false,
          ...(!isGitHub ? { access_token: token.trim() } : {}),
        }),
        signal: combined,
      })
    } catch {
      if (combined.aborted) throw new RepoActionError('remote-create-timeout', 'Creating the remote repository timed out.')
      throw new RepoActionError('remote-create-failed', 'Could not reach the Git hosting API.')
    }
    const text = await response.text()
    let data = {}
    if (text !== '') {
      try {
        data = JSON.parse(text)
      } catch {
        data = {}
      }
    }
    if (!response.ok) {
      const message = cleanGitText(typeof data.message === 'string' ? data.message : `HTTP ${String(response.status)}`)
      const code = response.status === 401 || response.status === 403
        ? 'token-invalid'
        : response.status === 422 ? 'remote-exists' : 'remote-create-failed'
      throw new RepoActionError(code, `Remote repository creation failed: ${message}`, { status: response.status })
    }
    const fullName = typeof data.full_name === 'string' ? data.full_name : ''
    const parts = fullName.split('/')
    if (parts.length !== 2 || !parts.every(part => part !== '.' && part !== '..' && REMOTE_SEGMENT.test(part))) {
      throw new RepoActionError('remote-create-failed', 'The hosting API returned no repository identity.')
    }
    const host = isGitHub ? 'github.com' : 'gitee.com'
    return {
      fullName,
      remoteUrl: `https://${host}/${fullName}.git`,
      webUrl: `https://${host}/${fullName}`,
    }
  }

  async publish(sessionCwd, input, signal) {
    if (this.busy) throw new RepoActionError('action-busy', 'Another repository operation is already running.')
    this.busy = true
    let hooksRoot = null
    try {
      const executable = await this.executable(signal)
      hooksRoot = await mkdtemp(join(tmpdir(), 'dsh-gbr-hooks-'))
      const hooksEnv = buildHooksEnv(hooksRoot)
      const provider = typeof input.provider === 'string' ? input.provider : 'none'
      if (provider !== 'none' && provider !== 'existing' && provider !== 'custom'
        && provider !== 'github' && provider !== 'gitee') {
        throw new RepoActionError('invalid-provider', 'Choose a valid repository destination.')
      }
      let selectedRemoteUrl = null
      if (provider === 'custom') selectedRemoteUrl = validateRemoteUrl(input.remoteUrl)
      if (provider === 'github' || provider === 'gitee') {
        validateRepoName(input.repoName)
        if (typeof input.token !== 'string' || input.token.trim() === '') {
          throw new RepoActionError('token-required', 'Enter a personal access token for the selected provider.')
        }
      }
      const relativePath = typeof input.path === 'string' ? input.path : ''
      const resolved = await resolveProjectPath(sessionCwd, relativePath)
      const rootCheck = await this.run(executable, resolved.target, ['rev-parse', '--show-toplevel'], {
        signal, maxBytes: 8_192,
      })
      let root = resolved.target
      let initialized = false
      let committed = false
      const alreadyGit = rootCheck.exitCode === 0
      let gitDir
      if (alreadyGit) {
        root = rootCheck.stdout.trim()
        if (root !== resolved.root && !root.startsWith(resolved.root + sep)) {
          throw new RepoActionError('invalid-path', 'The enclosing Git repository is outside the current workspace.')
        }
        gitDir = await this.validateGitDir(executable, root, resolved.root, signal)
      }

      if (!alreadyGit && provider === 'existing') {
        throw new RepoActionError('remote-missing', 'This repository has no origin remote to push to.')
      }

      if (!alreadyGit) {
        await this.assertNoGitEntry(root)
        const preview = await this.preview(sessionCwd, relativePath, signal)
        if (preview.status !== 'ok') {
          throw new RepoActionError('blocked', preview.reason === 'file-count'
            ? 'The selected directory contains too many files for a safe initial commit.'
            : 'The selected directory exceeds the initial-commit safety limits.', preview)
        }
        // Recheck after the preview window and initialize in a private directory
        // first, then atomically rename its .git into the project. The rename
        // cannot follow a symlink planted at the destination.
        await this.assertNoGitEntry(root)
        const before = await lstat(root)
        if (!before.isDirectory() || before.isSymbolicLink() || await realpath(root) !== root) {
          throw new RepoActionError('unsafe-git-dir', 'The project directory changed before initialization.')
        }
        const initTemp = await mkdtemp(join(root, '.dsh-git-init-'))
        try {
          const canonicalTemp = await realpath(initTemp)
          if (!canonicalTemp.startsWith(root + sep)) {
            throw new RepoActionError('unsafe-git-dir', 'The temporary repository directory escaped the project.')
          }
          const init = await this.run(executable, root, ['init', '--template', hooksRoot, '-b', 'main', initTemp], {
            signal, timeoutMs: 30_000, maxBytes: 64 * 1024, env: hooksEnv,
          })
          if (init.exitCode !== 0) {
            throw new RepoActionError('init-failed', `Could not initialize Git: ${cleanGitText(init.stderr)}`)
          }
          const current = await lstat(root)
          if (await realpath(root) !== root || current.ino !== before.ino || current.dev !== before.dev) {
            throw new RepoActionError('unsafe-git-dir', 'The project directory changed during initialization.')
          }
          await rename(join(initTemp, '.git'), join(root, '.git'))
        } finally {
          await rm(initTemp, { recursive: true, force: true })
        }
        initialized = true
        const after = await lstat(root)
        if (!after.isDirectory() || after.isSymbolicLink() || after.dev !== before.dev || after.ino !== before.ino) {
          throw new RepoActionError('unsafe-git-dir', 'The project directory changed during initialization.')
        }
        gitDir = await this.validateGitDir(executable, root, resolved.root, signal)
      }
      try {
        const head = await this.run(executable, root, ['rev-parse', '--verify', 'HEAD'], { signal, maxBytes: 8_192 })
        if (head.exitCode !== 0) {
          await this.ensureInitialCommit(executable, root, gitDir, input, signal, hooksEnv)
          committed = true
        }
      } catch (error) {
        if (error instanceof RepoActionError) {
          throw new RepoActionError(error.code, error.message, { ...error.details, initialized, root })
        }
        throw error
      }

      let remoteUrl = null
      let remoteCreated = false
      const setOrigin = async (url) => {
        try {
          await this.configureOrigin(executable, root, url, signal)
        } catch (error) {
          if (error instanceof RepoActionError) {
            throw new RepoActionError(error.code, error.message, {
              ...error.details, initialized, committed, root, remoteCreated,
              remoteUrl: redactRemoteUrl(url),
            })
          }
          throw error
        }
      }
      if (provider === 'custom') {
        remoteUrl = selectedRemoteUrl
        await setOrigin(remoteUrl)
      } else if (provider === 'existing') {
        const origin = await this.run(executable, root, ['remote', 'get-url', '--push', '--all', 'origin'], {
          signal, maxBytes: 16 * 1024,
        })
        const pushUrls = origin.exitCode === 0 ? origin.stdout.split('\n').filter(Boolean) : []
        if (pushUrls.length !== 1) {
          throw new RepoActionError('remote-missing', 'This repository needs exactly one push URL on origin.')
        }
        remoteUrl = validateRemoteUrl(pushUrls[0])
      } else if (provider === 'github' || provider === 'gitee') {
        let created
        try {
          created = await this.createRemote(provider, input.token, input.repoName, input.private === true, signal)
        } catch (error) {
          if (error instanceof RepoActionError) {
            throw new RepoActionError(error.code, error.message, { ...error.details, initialized, committed, root })
          }
          throw error
        }
        remoteUrl = created.remoteUrl
        remoteCreated = true
        await setOrigin(remoteUrl)
      }

      let pushed = false
      if (remoteUrl !== null) {
        try {
          pushed = await this.push(executable, root, provider, input.token, remoteUrl, hooksRoot, signal)
        } catch (error) {
          if (error instanceof RepoActionError) {
            throw new RepoActionError(error.code, error.message, {
              ...error.details, initialized, committed, root, remoteCreated,
              remoteUrl: redactRemoteUrl(remoteUrl),
            })
          }
          throw error
        }
      }
      const commit = await this.run(executable, root, ['rev-parse', 'HEAD'], { signal, maxBytes: 8_192 })
      const branch = branchName(await this.run(executable, root, ['symbolic-ref', '--short', '-q', 'HEAD'], { signal, maxBytes: 8_192 }))
      return {
        root,
        relativePath: relative(resolved.root, root) || '.',
        projectName: typeof input.projectName === 'string' && input.projectName.trim() !== ''
          ? input.projectName.trim().slice(0, 120)
          : basename(root),
        branch,
        commit: commit.exitCode === 0 ? commit.stdout.trim() : null,
        initialized,
        committed,
        provider,
        remoteUrl: remoteUrl === null ? null : redactRemoteUrl(remoteUrl),
        remoteCreated,
        pushed,
      }
    } finally {
      this.busy = false
      if (hooksRoot !== null) await rm(hooksRoot, { recursive: true, force: true })
    }
  }
}

export const __test = {
  SAFETY_EXCLUDES, BASE_GITIGNORE, parseNulPaths, remoteList, cleanText,
}

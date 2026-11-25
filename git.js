/** Bounded, read-only Git commands behind the branch-graph Host route. */

import { homedir } from 'node:os'
import { basename } from 'node:path'
import { shellQuote } from './remote.js'

const TIMEOUT_MS = 8_000
const STDOUT_MAX_BYTES = 1024 * 1024
const STDERR_MAX_BYTES = 16 * 1024
const MAX_COMMITS = 80
const FIELD = '\x1f'
const FORMAT = `%H%x1f%P%x1f%D%x1f%aI%x1f%an%x1f%s`

function cleanRef(decoration) {
  if (decoration.startsWith('HEAD -> ')) return decoration.slice(8)
  if (decoration.includes(' -> ')) return decoration.slice(decoration.lastIndexOf(' -> ') + 4)
  return decoration
}

/** Parse the unit-separated, one-line-per-commit format used by git log. */
export function parseGitLog(stdout) {
  const commits = []
  for (const line of stdout.split('\n')) {
    if (line === '') continue
    const fields = line.split(FIELD)
    if (fields.length < 6) continue
    const [hash, parents, decorations, date, author, ...subject] = fields
    if (!/^[0-9a-f]{40}$/i.test(hash)) continue
    const rawRefs = decorations === '' ? [] : decorations.split(', ')
    const refs = []
    let head = false
    for (const raw of rawRefs) {
      if (raw === 'HEAD' || raw.startsWith('HEAD -> ')) head = true
      const ref = cleanRef(raw)
      if (ref !== 'HEAD' && ref !== '' && !refs.includes(ref)) refs.push(ref)
    }
    commits.push({
      hash,
      parents: parents === '' ? [] : parents.split(' ').filter(parent => /^[0-9a-f]{40}$/i.test(parent)),
      refs,
      date,
      author,
      subject: subject.join(FIELD),
      head,
    })
  }
  return commits
}

function projectName(root) {
  const name = basename(root)
  return name === '' ? root : name
}

export async function resolveGitExecutable(ctx, signal) {
  let executable
  try {
    executable = await ctx.subprocess.resolveExecutable('git', undefined, signal)
  } catch {
    return null
  }
  if (process.platform !== 'darwin' || executable !== '/usr/bin/git') return executable
  // Avoid opening the macOS developer-tools installer from a background read.
  const probe = ctx.subprocess.spawn({
    argv: ['/usr/bin/xcode-select', '-p'],
    cwd: homedir(),
    stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } },
    graceMs: 1_000,
    signal,
  })
  const outcome = await probe.done.catch(() => ({ exitCode: null }))
  return outcome.exitCode === 0 ? executable : null
}

export class GitBranchReader {
  constructor(ctx, options = {}) {
    this.ctx = ctx
    this.gitPromise = options.executable === undefined ? undefined : Promise.resolve(options.executable)
  }

  executable(signal) {
    this.gitPromise ??= resolveGitExecutable(this.ctx, signal)
    return this.gitPromise
  }

  async run(executable, cwd, args, signal) {
    const timeout = AbortSignal.timeout(TIMEOUT_MS)
    const combined = AbortSignal.any([signal, timeout])
    const handle = this.ctx.subprocess.spawn({
      argv: [executable, ...args],
      cwd,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: STDOUT_MAX_BYTES },
        stderr: { maxBytes: STDERR_MAX_BYTES },
      },
      env: {
        GIT_CONFIG_COUNT: '0',
        GIT_TERMINAL_PROMPT: '0',
        GIT_OPTIONAL_LOCKS: '0',
        LC_ALL: 'C',
      },
      graceMs: 1_000,
      signal: combined,
    })
    const outcome = await handle.done
    if (combined.aborted) {
      throw new Error(timeout.aborted ? 'Git command timed out.' : 'Git command was cancelled.')
    }
    const stdout = handle.collected.stdout?.readFrom(0) ?? { text: '', lossy: false }
    if (stdout.lossy) throw new Error('Git output exceeded the 1 MiB safety limit.')
    return {
      exitCode: outcome.exitCode,
      stdout: stdout.text,
      stderr: handle.collected.stderr?.readFrom(0).text ?? '',
    }
  }

  async sshExecutable(signal) {
    if (this.sshPromise === undefined) {
      this.sshPromise = this.ctx.subprocess.resolveExecutable('ssh', undefined, signal)
        .catch(() => null)
        .then(value => value ?? 'ssh')
    }
    return this.sshPromise
  }

  async runRemoteCommand(connection, remoteCommand, signal, timeoutMs = TIMEOUT_MS) {
    if (typeof connection?.host !== 'string' || connection.host === ''
      || (connection.user !== null && connection.user !== undefined
        && (typeof connection.user !== 'string' || !/^[a-zA-Z0-9._-]+$/.test(connection.user)))
      || !Number.isInteger(connection.port) || connection.port < 1 || connection.port > 65535
      || (connection.key !== null && connection.key !== undefined
        && (typeof connection.key !== 'string' || !connection.key.startsWith('/') || connection.key.includes('\0')))) {
      throw new Error('Invalid remote connection.')
    }
    const executable = await this.sshExecutable(signal)
    const args = [
      '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8',
      '-o', 'StrictHostKeyChecking=yes', '-o', 'ServerAliveInterval=5',
      '-o', 'ServerAliveCountMax=1', '-o', 'LogLevel=ERROR',
    ]
    if (connection.key) args.push('-i', connection.key)
    if (connection.port !== 22) args.push('-p', String(connection.port))
    args.push(`${connection.user ? `${connection.user}@` : ''}${connection.host}`, remoteCommand)
    const timeout = AbortSignal.timeout(timeoutMs)
    const combined = AbortSignal.any([signal, timeout])
    const handle = this.ctx.subprocess.spawn({
      argv: [executable, ...args],
      cwd: homedir(),
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: STDOUT_MAX_BYTES },
        stderr: { maxBytes: STDERR_MAX_BYTES },
      },
      env: { HOME: homedir(), LC_ALL: 'C', SSH_ASKPASS: '/usr/bin/false', DISPLAY: '' },
      graceMs: 1_000,
      signal: combined,
    })
    const outcome = await handle.done
    if (combined.aborted) {
      throw new Error(timeout.aborted ? 'Remote Git command timed out.' : 'Remote Git command was cancelled.')
    }
    const stdout = handle.collected.stdout?.readFrom(0) ?? { text: '', lossy: false }
    if (stdout.lossy) throw new Error('Remote Git output exceeded the 1 MiB safety limit.')
    return {
      exitCode: outcome.exitCode,
      stdout: stdout.text,
      stderr: handle.collected.stderr?.readFrom(0).text ?? '',
    }
  }

  async remoteGit(connection, path, args, signal) {
    const command = `GIT_TERMINAL_PROMPT=0 GIT_OPTIONAL_LOCKS=0 git -C ${shellQuote(path)} ${args.map(shellQuote).join(' ')}`
    return this.runRemoteCommand(connection, command, signal)
  }

  /** Resolve remote repository roots for candidate project directories. */
  async resolveRemoteRoots(connection, paths, signal) {
    if (paths.length === 0) return []
    const list = paths.slice(0, 12)
    const command = `set -- ${list.map(shellQuote).join(' ')}; for p in "$@"; do `
      + 'r=$(GIT_TERMINAL_PROMPT=0 GIT_OPTIONAL_LOCKS=0 git -C "$p" rev-parse --show-toplevel 2>/dev/null) '
      + '&& printf \'%s\\t%s\\n\' "$p" "$r"; '
      + 'for d in "$p"/*; do [ -d "$d" ] || continue; '
      + 'r=$(GIT_TERMINAL_PROMPT=0 GIT_OPTIONAL_LOCKS=0 git -C "$d" rev-parse --show-toplevel 2>/dev/null) '
      + '&& printf \'%s\\t%s\\n\' "$d" "$r"; done; done'
    const result = await this.runRemoteCommand(connection, command, signal, 15_000)
    if (result.exitCode !== 0) throw new Error('Remote project discovery failed.')
    const seen = new Set()
    const roots = []
    for (const line of result.stdout.split(/\r?\n/)) {
      const index = line.indexOf('\t')
      if (index <= 0) continue
      const source = line.slice(0, index)
      const root = line.slice(index + 1).trim()
      if (root === '' || seen.has(root)) continue
      seen.add(root)
      roots.push({ source, root })
    }
    return roots
  }

  /** Read a repository on a remote host using a fixed, read-only Git command. */
  async readRemote(connection, path, signal) {
    const located = await this.remoteGit(connection, path, ['rev-parse', '--show-toplevel'], signal)
    if (located.exitCode !== 0) {
      if (/not a git repository/i.test(located.stderr)) {
        return { status: 'unavailable', reason: 'not-git', remote: true, remoteHost: connection.host }
      }
      if (/git: (?:command )?not found|git: not found/i.test(located.stderr)) {
        return { status: 'unavailable', reason: 'git-unavailable', remote: true, remoteHost: connection.host }
      }
      throw new Error(`remote git rev-parse failed: ${located.stderr.trim()}`)
    }
    const root = located.stdout.split('\n')[0].trim()
    if (root === '') throw new Error('remote git rev-parse returned an empty repository root.')
    const branchResult = await this.remoteGit(connection, root, ['symbolic-ref', '--short', '-q', 'HEAD'], signal)
    const currentBranch = branchResult.exitCode === 0 ? branchResult.stdout.trim() : null
    const logged = await this.remoteGit(connection, root, [
      'log', 'HEAD', '--branches', '--remotes', '--tags', '--topo-order',
      `--max-count=${MAX_COMMITS}`, `--format=${FORMAT}`,
    ], signal)
    if (logged.exitCode !== 0) {
      if (/does not have any commits yet|no commits yet|bad default revision|ambiguous argument 'HEAD'|unknown revision/i.test(logged.stderr)) {
        return {
          status: 'empty', root, projectName: projectName(root), currentBranch, commits: [],
          remote: true, remoteHost: connection.host,
        }
      }
      throw new Error(`remote git log failed: ${logged.stderr.trim()}`)
    }
    return {
      status: 'ok',
      root,
      projectName: projectName(root),
      currentBranch,
      commits: parseGitLog(logged.stdout),
      truncated: logged.stdout.split('\n').filter(Boolean).length >= MAX_COMMITS,
      remote: true,
      remoteHost: connection.host,
    }
  }

  /** Resolve the repository root enclosing a Session-derived directory. */
  async root(cwd, signal) {
    const executable = await this.executable(signal)
    if (executable === null) return null
    const result = await this.run(executable, cwd, ['rev-parse', '--show-toplevel'], signal)
    const root = result.stdout.trim()
    return result.exitCode === 0 && root !== '' ? root : null
  }

  /** Read the repository enclosing one Session-derived directory. */
  async read(cwd, signal) {
    const executable = await this.executable(signal)
    if (executable === null) return { status: 'unavailable', reason: 'git-unavailable' }

    const located = await this.run(executable, cwd, ['rev-parse', '--show-toplevel'], signal)
    if (located.exitCode !== 0) {
      if (/not a git repository/i.test(located.stderr)) return { status: 'unavailable', reason: 'not-git' }
      throw new Error(`git rev-parse failed: ${located.stderr.trim()}`)
    }
    const root = located.stdout.split('\n')[0].trim()
    if (root === '') throw new Error('git rev-parse returned an empty repository root.')

    const branchResult = await this.run(executable, root, ['symbolic-ref', '--short', '-q', 'HEAD'], signal)
    if (branchResult.exitCode !== 0 && branchResult.exitCode !== 1) {
      throw new Error(`git symbolic-ref failed: ${branchResult.stderr.trim()}`)
    }
    const currentBranch = branchResult.exitCode === 0 ? branchResult.stdout.trim() : null

    const logged = await this.run(executable, root, [
      'log', 'HEAD', '--branches', '--remotes', '--tags', '--topo-order',
      `--max-count=${MAX_COMMITS}`, `--format=${FORMAT}`,
    ], signal)
    if (logged.exitCode !== 0) {
      if (/does not have any commits yet|no commits yet|bad default revision|ambiguous argument 'HEAD'|unknown revision/i.test(logged.stderr)) {
        return { status: 'empty', root, projectName: projectName(root), currentBranch, commits: [] }
      }
      throw new Error(`git log failed: ${logged.stderr.trim()}`)
    }
    return {
      status: 'ok',
      root,
      projectName: projectName(root),
      currentBranch,
      commits: parseGitLog(logged.stdout),
      truncated: logged.stdout.split('\n').filter(Boolean).length >= MAX_COMMITS,
    }
  }
}

export const LIMITS = { MAX_COMMITS, STDOUT_MAX_BYTES, TIMEOUT_MS }

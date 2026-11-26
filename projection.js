/** Log-derived project list and refresh signals for the Git branch graph. */

import { basename, isAbsolute, relative, sep } from 'node:path'
import { extractExplicitRemotePaths, parseSshInvocations } from './remote.js'

const DEVELOPMENT_TOOLS = new Set([
  'bash', 'pwsh', 'read', 'write', 'edit', 'glob', 'grep', 'working_directory',
  'str_replace_editor', 'apply_patch', 'run_code',
])

const DIRECTORY_TOOLS = new Set(['glob', 'grep', 'working_directory'])
const FILE_TOOLS = new Set(['read', 'write', 'edit', 'str_replace_editor'])
const DEVELOPMENT_TEXT = /(?:开发|代码|编程|修复|调试|重构|实现|插件|接口|前端|后端|编译|构建|仓库|分支|报错|\b(?:code|coding|develop|development|implement|feature|bug|fix|debug|refactor|test|build|compile|plugin|repository|repo|git|branch|api|frontend|backend|typescript|javascript|python|rust|java)\b)/i
const MAX_PROJECTS = 6

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isAbsolutePath(value) {
  return typeof value === 'string' && value.length > 0 && (
    value.startsWith('/') || value.startsWith('\\\\') || /^[a-zA-Z]:[\\/]/.test(value)
  )
}

function parentDirectory(path) {
  const trimmed = path.replace(/[\\/]+$/, '')
  const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  if (index < 0) return path
  if (index === 0) return trimmed[0] === '\\' ? '\\' : '/'
  if (/^[a-zA-Z]:$/.test(trimmed.slice(0, index))) return trimmed.slice(0, index + 1)
  return trimmed.slice(0, index)
}

function messageText(content) {
  if (!Array.isArray(content)) return ''
  return content.map(block => isRecord(block) && block.type === 'text' && typeof block.text === 'string'
    ? block.text
    : '').join('\n')
}

function extractAbsolutePaths(text) {
  const matches = text.match(/(?:[a-zA-Z]:[\\/]|\/)[^\s"'`<>|]+/g) ?? []
  const seen = new Set()
  const paths = []
  for (const raw of matches) {
    const trimmed = raw.replace(/[),.;:!?\]]+$/, '')
    if (!isAbsolutePath(trimmed)) continue
    const last = trimmed.split(/[\\/]/).pop() ?? ''
    const candidate = last.includes('.') ? parentDirectory(trimmed) : trimmed
    if (!seen.has(candidate)) {
      seen.add(candidate)
      paths.push(candidate)
    }
    if (paths.length >= MAX_PROJECTS) break
  }
  return paths
}

function collectStrings(value, found = []) {
  if (typeof value === 'string') found.push(value)
  else if (Array.isArray(value)) { for (const item of value) collectStrings(item, found) }
  else if (isRecord(value)) { for (const item of Object.values(value)) collectStrings(item, found) }
  return found
}

function toolArguments(event) {
  try {
    const value = JSON.parse(event.data.arguments)
    return isRecord(value) ? value : {}
  } catch {
    return {}
  }
}

function projectDirectoryFromTool(name, args, fallback) {
  for (const key of ['workdir', 'cwd']) {
    if (isAbsolutePath(args[key])) return args[key]
  }
  if (DIRECTORY_TOOLS.has(name) && isAbsolutePath(args.path)) return args.path
  if (FILE_TOOLS.has(name)) {
    const file = args.file_path ?? args.target_file ?? args.path
    if (isAbsolutePath(file)) return parentDirectory(file)
  }
  return fallback
}

function relativeProject(base, directory) {
  if (!isAbsolutePath(base) || !isAbsolutePath(directory)) return null
  const rel = relative(base, directory)
  if (rel === '') return ''
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null
  return rel.split(sep).join('/')
}

function assignProject(state, directory, seq, source) {
  const path = relativeProject(state.cwd, directory)
  if (path === null) return null
  const id = path === '' ? 'root' : path
  if (id === state.activeProjectId && state.projects.some(project => project.id === id)) return null
  const label = path === '' ? basename(state.cwd) || state.cwd : basename(directory)
  const project = { id, path, label, lastSeq: seq, source }
  const projects = [project, ...state.projects.filter(item => item.id !== id)].slice(0, MAX_PROJECTS)
  return { ...state, projects, activeProjectId: id }
}

function nextSeq(state, event) {
  return Number.isSafeInteger(event.seq) ? event.seq : state.revision + 1
}

const MAX_REMOTE_PROJECTS = 32

function compactConnection(connection) {
  return {
    host: connection.host,
    user: connection.user ?? null,
    port: connection.port,
    jumps: connection.jumps ?? [],
    key: connection.key,
  }
}

function addRemoteProjects(state, args, seq) {
  const candidates = []
  for (const text of collectStrings(args)) {
    if (text.length < 20 || !/\bssh\b/.test(text)) continue
    const connections = parseSshInvocations(text)
    if (connections.length === 0) continue
    const paths = extractExplicitRemotePaths(text)
    if (paths.length === 0) continue
    for (const connection of connections) {
      const compact = compactConnection(connection)
      for (const path of paths) candidates.push({ connection: compact, path, lastSeq: seq })
    }
  }
  if (candidates.length === 0) return state
  const merged = new Map()
  for (const candidate of [...(state.remoteProjects ?? []), ...candidates]) {
    const key = `${candidate.connection.jumps?.join(',') ?? ''}|`
      + `${candidate.connection.user ?? ''}@${candidate.connection.host}:${candidate.connection.port}|`
      + `${candidate.connection.key ?? ''}|${candidate.path}`
    const previous = merged.get(key)
    if (previous === undefined || previous.lastSeq < candidate.lastSeq) merged.set(key, candidate)
  }
  const remoteProjects = [...merged.values()]
    .sort((left, right) => right.lastSeq - left.lastSeq)
    .slice(0, MAX_REMOTE_PROJECTS)
  if (JSON.stringify(remoteProjects) === JSON.stringify(state.remoteProjects ?? [])) return state
  return { ...state, remoteProjects }
}

function addRemoteHints(state, args, seq) {
  const hints = []
  for (const text of collectStrings(args)) {
    if (text.length < 20 || text.length > 12_000) continue
    if (!/(?:ssh\b|\.sh\b)/.test(text)) continue
    if (!/(?:\/(?:home|opt|srv|root|data|mnt|var\/www)\/|git\s+-C\b)/.test(text)) continue
    const trimmed = text.slice(0, 12_000)
    if (!hints.includes(trimmed)) hints.push(trimmed)
    if (hints.length >= 3) break
  }
  if (hints.length === 0) return state
  const entries = hints.map(text => ({ seq, text }))
  return {
    ...state,
    remoteHints: [...entries, ...(state.remoteHints ?? [])]
      .filter((hint, index, all) => all.findIndex(item => item.text === hint.text) === index)
      .slice(0, 16),
  }
}

function update(state, changes) {
  return { ...state, ...changes, revision: state.revision + 1 }
}

/**
 * Fold only durable Session events. The fold never touches the filesystem or
 * Git; the Host route validates and reads each project directory on demand.
 */
export function foldProject(state, event) {
  if (event.type === 'user/message') {
    if (event.data.source?.kind !== 'user') return state
    const text = messageText(event.data.content)
    let next = state
    let changed = false
    if (!next.development && DEVELOPMENT_TEXT.test(text)) {
      next = { ...next, development: true }
      changed = true
    }
    for (const directory of extractAbsolutePaths(text)) {
      const project = assignProject(next, directory, nextSeq(next, event), 'mention')
      if (project !== null) {
        next = project
        changed = true
      }
    }
    return changed ? update(next, {}) : state
  }

  if (event.type === 'tool/call') {
    const name = event.data.name
    if (!DEVELOPMENT_TOOLS.has(name)) return state
    const args = toolArguments(event)
    const seq = nextSeq(state, event)
    const directory = projectDirectoryFromTool(name, args, state.cwd)
    const project = directory === null ? null : assignProject(state, directory, seq, 'tool')
    let next = project === null
      ? (state.development ? state : { ...state, development: true })
      : { ...project, development: true }
    const hinted = addRemoteHints(next, args, seq)
    if (hinted !== next) {
      next = { ...hinted, development: true }
    }
    const projected = addRemoteProjects(next, args, seq)
    if (projected !== next) {
      next = { ...projected, development: true }
    }
    if (next === state) return state
    return update(next, {})
  }

  // A turn boundary is a durable refresh signal for commits made by shell or
  // file tools. It is intentionally independent of assistant prose.
  if (event.type === 'turn/end' && state.development) {
    return update(state, {})
  }
  return state
}

function validProject(value) {
  return isRecord(value)
    && typeof value.id === 'string' && value.id !== ''
    && typeof value.path === 'string'
    && typeof value.label === 'string' && value.label !== ''
    && Number.isSafeInteger(value.lastSeq) && value.lastSeq >= 0
    && (value.source === 'session' || value.source === 'tool' || value.source === 'mention')
}

function validRemoteHint(value) {
  return isRecord(value)
    && Number.isSafeInteger(value.seq) && value.seq >= 0
    && typeof value.text === 'string' && value.text.length > 0
}

function validRemoteConnection(value) {
  return isRecord(value)
    && typeof value.host === 'string' && value.host !== ''
    && (typeof value.user === 'string' || value.user === null)
    && Number.isSafeInteger(value.port) && value.port > 0 && value.port <= 65535
    && Array.isArray(value.jumps) && value.jumps.every(jump => typeof jump === 'string')
    && (typeof value.key === 'string' || value.key === null)
}

function validRemoteProject(value) {
  return isRecord(value)
    && validRemoteConnection(value.connection)
    && typeof value.path === 'string' && value.path.startsWith('/')
    && Number.isSafeInteger(value.lastSeq) && value.lastSeq >= 0
}

function validState(value) {
  return isRecord(value)
    && typeof value.development === 'boolean'
    && (typeof value.cwd === 'string' || value.cwd === null)
    && Number.isSafeInteger(value.revision) && value.revision >= 0
    && (typeof value.activeProjectId === 'string' || value.activeProjectId === null)
    && Array.isArray(value.projects) && value.projects.every(validProject)
    && (value.remoteHints === undefined
      || (Array.isArray(value.remoteHints) && value.remoteHints.every(validRemoteHint)))
    && (value.remoteProjects === undefined
      || (Array.isArray(value.remoteProjects) && value.remoteProjects.every(validRemoteProject)))
}

const stateSchema = {
  parse(value) {
    if (!validState(value)) throw new TypeError('Invalid gitBranchGraph projection state')
    return value
  },
}

export function createProjectionDefinition() {
  return {
    key: 'gitBranchGraph',
    stateVersion: 4,
    stateSchema,
    init(header) {
      const cwd = typeof header.cwd === 'string' ? header.cwd : null
      const projects = cwd === null ? [] : [{
        id: 'root',
        path: '',
        label: basename(cwd) || cwd,
        lastSeq: 0,
        source: 'session',
      }]
      return {
        development: false,
        cwd,
        revision: 0,
        activeProjectId: projects[0]?.id ?? null,
        projects,
        remoteHints: [],
        remoteProjects: [],
      }
    },
    apply: foldProject,
    wire: {
      viewSchema: stateSchema,
      view: (state) => {
        const { remoteHints, remoteProjects, ...view } = state
        return view
      },
      // Full values belong to the opened Session, not every sidebar row.
      summary: false,
    },
  }
}

export const __test = {
  isAbsolutePath, parentDirectory, messageText, projectDirectoryFromTool,
  extractAbsolutePaths, relativeProject, assignProject,
}

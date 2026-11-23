/** Log-derived project and refresh signals for the Git branch graph. */

const DEVELOPMENT_TOOLS = new Set([
  'bash', 'pwsh', 'read', 'write', 'edit', 'glob', 'grep', 'working_directory',
  'str_replace_editor', 'apply_patch',
])

const DIRECTORY_TOOLS = new Set(['glob', 'grep', 'working_directory'])
const FILE_TOOLS = new Set(['read', 'write', 'edit', 'str_replace_editor'])
const DEVELOPMENT_TEXT = /(?:开发|代码|编程|修复|调试|重构|实现|插件|接口|前端|后端|编译|构建|仓库|分支|报错|\b(?:code|coding|develop|development|implement|feature|bug|fix|debug|refactor|test|build|compile|plugin|repository|repo|git|branch|api|frontend|backend|typescript|javascript|python|rust|java)\b)/i

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

function update(state, changes) {
  const next = { ...state, ...changes }
  next.revision = state.revision + 1
  return next
}

/**
 * Fold only durable Session events. The fold never touches the filesystem or
 * Git; the Host route validates and reads the resulting directory on demand.
 */
export function foldProject(state, event) {
  if (event.type === 'user/message') {
    if (state.development || event.data.source?.kind !== 'user') return state
    if (!DEVELOPMENT_TEXT.test(messageText(event.data.content))) return state
    return update(state, { development: true })
  }

  if (event.type === 'tool/call') {
    const name = event.data.name
    if (!DEVELOPMENT_TOOLS.has(name)) return state
    const cwd = projectDirectoryFromTool(name, toolArguments(event), state.cwd)
    if (state.development && cwd === state.cwd) return state
    return update(state, {
      development: true,
      cwd,
      ...(cwd !== state.cwd ? { source: 'tool' } : {}),
    })
  }

  // A turn boundary is a durable refresh signal for commits made by shell or
  // file tools. It is intentionally independent of assistant prose.
  if (event.type === 'turn/end' && state.development) {
    return update(state, {})
  }
  return state
}

function validState(value) {
  return isRecord(value)
    && typeof value.development === 'boolean'
    && (typeof value.cwd === 'string' || value.cwd === null)
    && Number.isSafeInteger(value.revision) && value.revision >= 0
    && (value.source === 'session' || value.source === 'tool')
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
    stateVersion: 1,
    stateSchema,
    init(header) {
      return {
        development: false,
        cwd: typeof header.cwd === 'string' ? header.cwd : null,
        revision: 0,
        source: 'session',
      }
    },
    apply: foldProject,
    wire: {
      viewSchema: stateSchema,
      view: state => state,
      // Full values belong to the opened Session, not every sidebar row.
      summary: false,
    },
  }
}

export const __test = { isAbsolutePath, parentDirectory, messageText, projectDirectoryFromTool }

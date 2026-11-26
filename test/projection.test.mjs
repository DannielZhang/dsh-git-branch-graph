import test from 'node:test'
import assert from 'node:assert/strict'
import { createProjectionDefinition, foldProject, __test } from '../projection.js'

const initial = {
  development: false,
  cwd: '/workspace/main',
  revision: 0,
  activeProjectId: 'root',
  projects: [{ id: 'root', path: '', label: 'main', lastSeq: 0, source: 'session' }],
  remoteHints: [],
  remoteProjects: [],
}
const user = text => ({
  type: 'user/message',
  data: { source: { kind: 'user' }, content: [{ type: 'text', text }] },
})
const call = (name, args = {}) => ({ type: 'tool/call', data: { name, arguments: JSON.stringify(args) } })

test('session header supplies the initial project without marking development', () => {
  const definition = createProjectionDefinition()
  assert.deepEqual(definition.init({ cwd: '/repo' }, 0), {
    ...initial,
    cwd: '/repo',
    projects: [{ id: 'root', path: '', label: 'repo', lastSeq: 0, source: 'session' }],
  })
  assert.equal(definition.wire.summary, false)
  assert.equal(definition.wire.viewSchema.parse(initial), initial)
})

test('development text activates the graph but injected context does not', () => {
  const next = foldProject(initial, user('请修复这个插件并构建它'))
  assert.equal(next.development, true)
  assert.equal(next.revision, 1)
  const injected = { type: 'user/message', data: { source: { kind: 'inject' }, content: [{ type: 'text', text: 'fix code' }] } }
  assert.equal(foldProject(initial, injected), initial)
})

test('ordinary conversation and malformed tool JSON preserve state identity', () => {
  assert.equal(foldProject(initial, user('今天天气怎么样')), initial)
  const malformed = foldProject(initial, { type: 'tool/call', data: { name: 'bash', arguments: '{' } })
  assert.equal(malformed.development, true)
  assert.equal(malformed.cwd, initial.cwd)
  assert.equal(foldProject(initial, { type: 'turn/start', data: { turn: 1 } }), initial)
})

test('tool workdir adds a recent project and keeps the session root', () => {
  const next = foldProject(initial, call('bash', { command: 'git status', workdir: '/workspace/main/other' }))
  assert.equal(next.development, true)
  assert.equal(next.cwd, '/workspace/main')
  assert.equal(next.revision, 1)
  assert.equal(next.activeProjectId, 'other')
  assert.deepEqual(next.projects.map(project => project.id), ['other', 'root'])
  assert.equal(next.projects[0].label, 'other')
  const ended = foldProject(next, { type: 'turn/end', data: {} })
  assert.equal(ended.revision, 2)
  assert.equal(ended.activeProjectId, 'other')
})

test('multiple project workdirs stay available and move to the front when revisited', () => {
  const first = foldProject(initial, call('bash', { workdir: '/workspace/main/alpha' }))
  const second = foldProject(first, call('bash', { workdir: '/workspace/main/beta' }))
  assert.deepEqual(second.projects.map(project => project.id), ['beta', 'alpha', 'root'])
  assert.equal(second.activeProjectId, 'beta')
  const revisited = foldProject(second, call('bash', { workdir: '/workspace/main/alpha' }))
  assert.deepEqual(revisited.projects.map(project => project.id), ['alpha', 'beta', 'root'])
  assert.equal(revisited.activeProjectId, 'alpha')
  assert.equal(foldProject(revisited, call('bash', { workdir: '/tmp/outside' })).activeProjectId, 'alpha')
})

test('absolute project paths mentioned in user text are tracked', () => {
  const next = foldProject(initial, user('同时修改 /workspace/main/alpha 和 /workspace/main/beta 的代码'))
  assert.equal(next.activeProjectId, 'beta')
  assert.deepEqual(next.projects.map(project => project.id), ['beta', 'alpha', 'root'])
  assert.deepEqual(
    __test.extractAbsolutePaths('见 /workspace/main/src/app.ts 和 /workspace/main/beta'),
    ['/workspace/main/src', '/workspace/main/beta'],
  )
})

test('run_code SSH wrappers record bounded remote hints without exposing them on the wire', () => {
  const definition = createProjectionDefinition()
  const next = foldProject(initial, call('run_code', {
    code: "await tools.bash({ command: \"./rssh.sh 'cd /home/sradmin/vllm && git log'\" })",
  }))
  assert.equal(next.development, true)
  assert.equal(next.remoteHints.length, 1)
  assert.match(next.remoteHints[0].text, /\/home\/sradmin\/vllm/)
  assert.equal(definition.wire.view(next).remoteHints, undefined)
  assert.equal(definition.wire.view(next).remoteProjects, undefined)
})

test('direct ProxyJump commands accumulate compact remote project candidates', () => {
  const definition = createProjectionDefinition()
  const next = foldProject(initial, call('bash', {
    command: "ssh -o BatchMode=yes -J root@1.15.124.163 -p 2333 sradmin@10.66.66.2 'cd /home/sradmin/dsh_ws_dev/AuditSystem && git status'",
  }))
  assert.equal(next.remoteProjects.length, 1)
  assert.equal(next.remoteProjects[0].path, '/home/sradmin/dsh_ws_dev/AuditSystem')
  assert.deepEqual(next.remoteProjects[0].connection.jumps, ['root@1.15.124.163'])
  assert.equal(next.remoteProjects[0].connection.port, 2333)
  const wire = definition.wire.view(next)
  assert.equal(wire.remoteProjects, undefined)
  assert.equal(wire.remoteHints, undefined)
})

test('file tools select their containing repository and directory tools keep the directory', () => {
  assert.equal(__test.projectDirectoryFromTool('read', { file_path: '/repo/src/a.ts' }, null), '/repo/src')
  assert.equal(__test.projectDirectoryFromTool('edit', { path: 'C:\\repo\\src\\a.ts' }, null), 'C:\\repo\\src')
  assert.equal(__test.projectDirectoryFromTool('grep', { path: '/repo/src' }, null), '/repo/src')
  assert.equal(__test.projectDirectoryFromTool('working_directory', { path: '/repo' }, null), '/repo')
})

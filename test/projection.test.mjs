import test from 'node:test'
import assert from 'node:assert/strict'
import { createProjectionDefinition, foldProject, __test } from '../projection.js'

const initial = { development: false, cwd: '/workspace/main', revision: 0, source: 'session' }
const user = text => ({
  type: 'user/message',
  data: { source: { kind: 'user' }, content: [{ type: 'text', text }] },
})
const call = (name, args = {}) => ({ type: 'tool/call', data: { name, arguments: JSON.stringify(args) } })

test('session header supplies the initial project without marking development', () => {
  const definition = createProjectionDefinition()
  assert.deepEqual(definition.init({ cwd: '/repo' }, 0), { ...initial, cwd: '/repo' })
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

test('tool workdir changes the selected project and turn end refreshes it', () => {
  const next = foldProject(initial, call('bash', { command: 'git status', workdir: '/workspace/other' }))
  assert.deepEqual(next, { development: true, cwd: '/workspace/other', revision: 1, source: 'tool' })
  const ended = foldProject(next, { type: 'turn/end', data: {} })
  assert.equal(ended.revision, 2)
  assert.equal(ended.cwd, '/workspace/other')
})

test('file tools select their containing repository and directory tools keep the directory', () => {
  assert.equal(__test.projectDirectoryFromTool('read', { file_path: '/repo/src/a.ts' }, null), '/repo/src')
  assert.equal(__test.projectDirectoryFromTool('edit', { path: 'C:\\repo\\src\\a.ts' }, null), 'C:\\repo\\src')
  assert.equal(__test.projectDirectoryFromTool('grep', { path: '/repo/src' }, null), '/repo/src')
  assert.equal(__test.projectDirectoryFromTool('working_directory', { path: '/repo' }, null), '/repo')
})

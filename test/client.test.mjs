import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

function loadClient() {
  let declaration
  const window = { __ModuleLoader__: { load(value) { declaration = value } } }
  vm.runInNewContext(readFileSync(new URL('../client.js', import.meta.url), 'utf8'), { window, console })
  const React = { createElement: (type, props, ...children) => ({ type, props, children }) }
  return declaration.factory(name => {
    if (name === 'react') return React
    if (name === 'react-dom') return { createPortal: node => node }
    throw new Error(`Unexpected module ${name}`)
  })
}

const client = loadClient()
const {
  layoutGraph, normalizeGraph, commitCountLabel, HIDDEN_UNAVAILABLE, computeFloatingLayout,
  computeDockedLayout, mergeProjectList, dictionaries,
} = client.__test
const commit = (hash, parents = [], refs = []) => ({
  hash, parents, refs, subject: hash, date: '2026-11-23T00:00:00Z', author: 'Tester', head: false,
})

test('layout connects merge parents to their actual nodes without duplicate rows', () => {
  const a = 'a'.repeat(40), b = 'b'.repeat(40), c = 'c'.repeat(40), d = 'd'.repeat(40)
  const graph = layoutGraph([
    commit(a, [b, c], ['main']), commit(b, [d]), commit(c, [d], ['feature']), commit(d),
  ])
  assert.equal(graph.rows.length, 4)
  assert.equal(new Set(graph.rows.map(row => row.commit.hash)).size, 4)
  assert.equal(graph.edges.length, 4)
  assert.ok(graph.laneCount >= 2)
  for (const edge of graph.edges) assert.match(edge.d, /^M \d+ \d+ (?:L|C)/)
})

test('layout tolerates roots, missing off-screen parents and detached HEAD', () => {
  const a = 'a'.repeat(40), missing = 'f'.repeat(40)
  const graph = layoutGraph([commit(a, [missing])])
  assert.equal(graph.rows.length, 1)
  assert.equal(graph.edges.length, 0)
  assert.equal(graph.laneCount, 1)
})

test('client validates Host graph payloads', () => {
  const graph = {
    status: 'ok', root: '/repo', projectName: 'repo', currentBranch: 'main',
    commits: [commit('a'.repeat(40))],
  }
  assert.equal(normalizeGraph(graph), graph)
  assert.deepEqual(normalizeGraph({ status: 'unavailable', reason: 'not-git' }), { status: 'unavailable', reason: 'not-git' })
  assert.throws(() => normalizeGraph({ status: 'ok', root: '/repo' }))
})

test('single commit uses singular copy and only expected absences hide the dock', () => {
  const t = (key, values = {}) => {
    if (key === 'commitOne' || key === 'truncatedOne') return key
    return `${key}:${values.count ?? ''}`
  }
  assert.equal(commitCountLabel({ commits: [{}], truncated: false }, t), 'commitOne')
  assert.equal(commitCountLabel({ commits: [{}, {}], truncated: false }, t), 'commits:2')
  assert.equal(commitCountLabel({ commits: [{}], truncated: true }, t), 'truncatedOne')
  assert.equal(HIDDEN_UNAVAILABLE.has('not-git'), false)
  assert.equal(HIDDEN_UNAVAILABLE.has('git-unavailable'), false)
})

test('project list keeps recency order and appends a created repository', () => {
  const projects = [
    { id: 'beta', path: 'beta', label: 'beta', lastSeq: 8, source: 'tool' },
    { id: 'root', path: '', label: 'main', lastSeq: 0, source: 'session' },
  ]
  assert.equal(mergeProjectList({ projects }, '/main', '').map(project => project.id).join(','), 'beta,root')
  assert.equal(
    mergeProjectList({ projects }, '/main', 'created').map(project => project.id).join(','),
    'beta,root,created:created',
  )
  assert.equal(mergeProjectList(undefined, '/main', '').map(project => project.id).join(','), 'root')
})

test('docked layout fills the reserved right track and follows its width', () => {
  const geometry = {
    left: 280, right: 1268, top: 48, bottom: 948, width: 988, height: 900,
    contentWidth: 920, viewportWidth: 1728,
  }
  const docked = computeDockedLayout(geometry, 1728)
  assert.equal(JSON.stringify(docked), JSON.stringify({
    top: 56, right: 8, width: 444, maxHeight: 884,
  }))
  const narrower = { ...geometry, right: 1368 }
  assert.equal(computeDockedLayout(narrower, 1728).width, 344)
  assert.equal(computeDockedLayout({ ...geometry, right: 1500 }, 1728), null)
})

test('Chinese and English client dictionaries expose the same keys', () => {
  assert.deepEqual(Object.keys(dictionaries.en).sort(), Object.keys(dictionaries.zh).sort())
})

test('client apply registers the overlay and its main-conversation geometry bridge', () => {
  const registrations = []
  const mounted = { getSnapshot: () => 'session-1', subscribe: () => () => {} }
  const ctx = {
    effect(fn) { fn() },
    on() {},
    locale: { register() { return () => {} } },
    sidebarRight: { mounted },
    sessions: {
      binding() {
        return { session: { projections: { faceOf: () => ({ getSnapshot: () => undefined, subscribe: () => () => {} }) } } }
      },
      retainInfo() {
        return { getSnapshot: () => ({ referenceCount: 1 }), subscribe: () => () => {} }
      },
    },
    slots: {
      inject(name, callback) { callback() },
      register(options) {
        registrations.push(options)
        return () => {}
      },
    },
  }
  client.apply(ctx)
  assert.equal(client.inject.join(','), 'slots,locale,sessions,sidebarRight,layout')
  assert.deepEqual(registrations.map(entry => entry.name), ['shell.overlay', 'conversation.input.dock'])
  assert.equal(registrations[0].id, 'git-branch-graph')
  assert.equal(registrations[1].id, 'git-branch-graph-geometry')
  const overlay = registrations[0].inject()
  assert.equal(overlay.getMounted(), 'session-1')
  assert.equal(typeof overlay.getProjectionFace('session-1').getSnapshot, 'function')
  assert.equal(overlay.getSessionRetention('session-1').getSnapshot().referenceCount, 1)
})

test('floating panel occupies the right gutter and hides when it is too narrow', () => {
  const wide = {
    left: 280, right: 1728, top: 48, bottom: 1000, width: 1448, height: 952,
    contentWidth: 920, viewportWidth: 1728,
  }
  assert.equal(JSON.stringify(computeFloatingLayout(wide, false, 1728)), JSON.stringify({
    top: 64, right: 16, width: 232, maxHeight: 920,
  }))
  const veryWide = { ...wide, right: 2560, width: 2280, viewportWidth: 2560 }
  assert.equal(computeFloatingLayout(veryWide, false, 2560).width, 460)
  assert.equal(computeFloatingLayout(veryWide, true, 2560).width, 220)
  const laptop = {
    left: 280, right: 1512, top: 48, bottom: 900, width: 1232, height: 852,
    contentWidth: 788, viewportWidth: 1512,
  }
  assert.equal(computeFloatingLayout(laptop, false, 1512).width, 190)
  const narrow = { ...wide, right: 1440, width: 1160, contentWidth: 742, viewportWidth: 1440 }
  assert.equal(computeFloatingLayout(narrow, false, 1440), null)
  assert.equal(computeFloatingLayout(null, false, 1440), null)
})

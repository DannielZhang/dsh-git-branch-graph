import test from 'node:test'
import assert from 'node:assert/strict'
import {
  extractExplicitRemotePaths, extractRemotePaths, extractScriptReferences, parseSshInvocations,
  parseWrapperScript, remoteProjectId,
} from '../remote.js'

test('parses direct SSH options without accepting shell-injected destinations', () => {
  const [connection] = parseSshInvocations(
    'ssh -i /Users/me/.ssh/key -p 2333 -o ConnectTimeout=10 -T sradmin@192.168.134.165 '
      + '"cd /home/sradmin/vllm && git status"',
  )
  assert.deepEqual(connection, {
    host: '192.168.134.165', user: 'sradmin', port: 2333, key: '/Users/me/.ssh/key',
    jumps: [], remoteCommand: 'cd /home/sradmin/vllm && git status',
  })
  assert.equal(parseSshInvocations('ssh -p 70000 user@host').length, 0)
  assert.equal(parseSshInvocations('ssh -p 22 -o ProxyCommand=x user@host').length, 1)
})

test('parses a ProxyJump hop for a two-hop SSH target', () => {
  const [connection] = parseSshInvocations(
    'ssh -o BatchMode=yes -J root@1.15.124.163 -p 2333 sradmin@10.66.66.2 '
      + '"cd /home/sradmin/dsh_ws_dev/AuditSystem && git status"',
  )
  assert.deepEqual(connection.jumps, ['root@1.15.124.163'])
  assert.equal(connection.user, 'sradmin')
  assert.equal(connection.host, '10.66.66.2')
  assert.equal(connection.port, 2333)
})

test('parses variables and the destination from an SSH wrapper script', () => {
  const connections = parseWrapperScript([
    '#!/bin/bash',
    'KEY="/Users/me/work/.ssh/wsl_sradmin"',
    'HOST="sradmin@192.168.134.165"',
    'PORT="2333"',
    'exec ssh -i "$KEY" -p $PORT -o ConnectTimeout=12 "$HOST" "$*"',
  ].join('\n'))
  assert.equal(connections.length, 1)
  assert.equal(connections[0].host, '192.168.134.165')
  assert.equal(connections[0].user, 'sradmin')
  assert.equal(connections[0].port, 2333)
  assert.equal(connections[0].key, '/Users/me/work/.ssh/wsl_sradmin')
})

test('extracts wrapper references and deepest remote project directories', () => {
  const text = [
    "/Users/me/work/rssh.sh 'cd /home/sradmin/vllm && git log'",
    'du -sh /home/sradmin/llamaCpp /home/sradmin/llamaCpp/llama.cpp /home/sradmin/docling',
    'ls /home/sradmin/vllm/vllm_env/lib/python3.12/site-packages/vllm',
  ].join('\n')
  assert.deepEqual(extractScriptReferences(text), ['/Users/me/work/rssh.sh'])
  const paths = extractRemotePaths(text)
  assert.ok(paths.includes('/home/sradmin/vllm'))
  assert.ok(paths.includes('/home/sradmin/llamaCpp/llama.cpp'))
  assert.ok(paths.includes('/home/sradmin/docling'))
  assert.ok(!paths.includes('/home/sradmin/vllm/vllm_env'))
})

test('explicit cd paths identify project roots without globs or variables', () => {
  assert.deepEqual(extractExplicitRemotePaths(
    "cd /home/sradmin/dsh_ws_dev/AuditSystem && git status; cd /home/sradmin/\$x; cd /home/sradmin/*",
  ), ['/home/sradmin/dsh_ws_dev/AuditSystem'])
})

test('remote project ids are stable and connection-specific', () => {
  const first = remoteProjectId({ user: 'u', host: 'host', port: 22 }, '/home/u/app')
  assert.equal(first, remoteProjectId({ user: 'u', host: 'host', port: 22 }, '/home/u/app'))
  assert.notEqual(first, remoteProjectId({ user: 'u', host: 'host', port: 23 }, '/home/u/app'))
})

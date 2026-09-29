import assert from 'node:assert/strict'
import test from 'node:test'
import { observeSmokeOutput } from '../src/main/smoke-output'

test('Electron smoke detects a token at the start of an oversized first frame', () => {
  const token = 'petty-electron-smoke-token'
  const output = observeSmokeOutput('', token + 'x'.repeat(5403), token)
  assert.equal(output.sawToken, true)
  assert.equal(output.tail, 'x'.repeat(4096))
})

test('Electron smoke detects an echo followed by more than 4 KiB of flood output', () => {
  const output = observeSmokeOutput('ECHO:', 'probe' + 'x'.repeat(8192), 'startup', 'ECHO:probe')
  assert.equal(output.sawEcho, true)
  assert.equal(output.sawToken, false)
})

test('Electron smoke detects a token split across frames', () => {
  const first = observeSmokeOutput('', 'petty-electron-', 'petty-electron-smoke-token')
  const second = observeSmokeOutput(
    first.tail,
    'smoke-token' + 'x'.repeat(5403),
    'petty-electron-smoke-token',
  )
  assert.equal(second.sawToken, true)
  assert.equal(second.tail, 'x'.repeat(4096))
})

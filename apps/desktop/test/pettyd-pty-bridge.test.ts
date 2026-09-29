import { EventEmitter } from 'node:events'
import assert from 'node:assert/strict'
import test from 'node:test'
import type { MessagePortMain } from 'electron'
import { PettydStreamFrameKind } from '@petty/shared/pettyd-protocol'
import { PettydPtyBridge } from '../src/main/pettyd-pty-bridge'
import type { PettydClient, PettydSessionStream } from '../src/main/pettyd-client'

class Port extends EventEmitter {
  messages: unknown[] = []
  closed = false
  start() {}
  postMessage(message: unknown) {
    this.messages.push(message)
  }
  close() {
    if (this.closed) return
    this.closed = true
    this.emit('close')
  }
  send(data: unknown) {
    this.emit('message', { data })
  }
  main() {
    return this as unknown as MessagePortMain
  }
}

class Stream extends EventEmitter {
  started = false
  closed = false
  input: Uint8Array[] = []
  start() {
    this.started = true
  }
  close() {
    if (this.closed) return
    this.closed = true
    this.emit('close')
  }
  writeInput(data: Uint8Array) {
    this.input.push(data)
  }
  frame(seq = 1) {
    this.emit('frame', {
      sessionId: 's',
      kind: PettydStreamFrameKind.Output,
      seq,
      payload: Uint8Array.of(65),
    })
  }
}

const turn = () => new Promise<void>((resolve) => setImmediate(resolve))
function fixture() {
  type Attached = { response: { ok: true }; stream: PettydSessionStream }
  const pending: Array<ReturnType<typeof Promise.withResolvers<Attached>>> = []
  const client = {
    attachSession() {
      const call = Promise.withResolvers<Attached>()
      pending.push(call)
      return call.promise
    },
    async detachSession() {},
  }
  const bridge = new PettydPtyBridge({ client: client as unknown as PettydClient })
  const control = new Port()
  bridge.connectPort(control.main())
  const channel = new Port()
  bridge.connectSessionPort('s', channel.main())
  const attach = (port = control) =>
    port.send({ type: 'attach', sessionId: 's', cols: 80, rows: 24 })
  const resolve = async (index: number, stream = new Stream()) => {
    pending[index]!.resolve({
      response: { ok: true },
      stream: stream as unknown as PettydSessionStream,
    })
    await turn()
    return stream
  }
  return { bridge, control, channel, attach, resolve, pending }
}

for (const cancel of ['session-port', 'control-port', 'dispose'] as const) {
  test(`${cancel} teardown cancels an attach RPC before its stream arrives`, async () => {
    const f = fixture()
    try {
      f.attach()
      assert.equal(f.pending.length, 1)
      if (cancel === 'session-port') f.channel.close()
      else if (cancel === 'control-port') f.control.close()
      else f.bridge.dispose()
      const stream = await f.resolve(0)
      assert.equal(stream.closed, true)
      assert.equal(stream.started, false)
      assert.deepEqual(f.control.messages, [])
      assert.equal(f.bridge.getDiagnostics().messagesDroppedNoPortTotal, 0)
    } finally {
      f.bridge.dispose()
    }
  })
}

test('closing a port during first-frame wait closes its stream and suppresses stale frames/errors', async () => {
  const f = fixture()
  try {
    f.attach()
    const stream = await f.resolve(0)
    assert.equal(stream.started, true)
    f.channel.close()
    assert.equal(stream.closed, true)
    stream.frame()
    stream.emit('error', new Error('old socket closed'))
    await turn()
    assert.deepEqual(f.control.messages, [])
    assert.partialDeepStrictEqual(f.bridge.getDiagnostics(), {
      activeStreams: 0,
      messagesDroppedNoPortTotal: 0,
    })
  } finally {
    f.bridge.dispose()
  }
})

test('late attach completion cannot replace the new renderer stream', async () => {
  const f = fixture()
  try {
    f.attach()
    f.channel.close()
    const channel = new Port()
    f.bridge.connectSessionPort('s', channel.main())
    f.attach()
    const current = await f.resolve(1)
    current.frame(2)
    await turn()
    const obsolete = await f.resolve(0)
    assert.equal(obsolete.closed, true)
    assert.equal(current.closed, false)
    channel.send({ type: 'input', data: Uint8Array.of(9) })
    assert.deepEqual(
      current.input.map((bytes) => [...bytes]),
      [[9]],
    )
    current.frame(3)
    assert.equal(channel.messages.length, 2)
    assert.equal(f.control.messages.filter((message: any) => message.type === 'ready').length, 1)
    assert.ok(
      f.control.messages.some(
        (message: any) =>
          message.type === 'process-title' &&
          message.sessionId === 's' &&
          typeof message.title === 'string',
      ),
    )
  } finally {
    f.bridge.dispose()
  }
})

test('replacing the control port revokes old channels and ignores queued old control requests', async () => {
  const f = fixture()
  try {
    f.attach()
    const control = new Port()
    f.bridge.connectPort(control.main())
    assert.equal(f.channel.closed, true)
    const obsolete = await f.resolve(0)
    assert.equal(obsolete.closed, true)
    const channel = new Port()
    f.bridge.connectSessionPort('s', channel.main())
    f.attach(control)
    const current = await f.resolve(1)
    current.frame()
    await turn()
    f.control.send({ type: 'detach', sessionId: 's' })
    f.channel.send({ type: 'resync', seq: 0 })
    assert.equal(current.closed, false)
    assert.equal(channel.closed, false)
    assert.equal(f.pending.length, 2)
    assert.equal(control.messages.filter((message: any) => message.type === 'ready').length, 1)
  } finally {
    f.bridge.dispose()
  }
})

test('a late failure from an obsolete attach cannot clear the replacement renderer ready state', async () => {
  const f = fixture()
  try {
    f.attach()
    f.channel.close()
    const channel = new Port()
    f.bridge.connectSessionPort('s', channel.main())
    f.attach()
    const current = await f.resolve(1)
    current.frame()
    await turn()
    f.pending[0]!.reject(new Error('old attach failed'))
    await turn()
    assert.equal(f.control.messages.filter((message: any) => message.type === 'ready').length, 1)
    assert.equal(current.closed, false)
  } finally {
    f.bridge.dispose()
  }
})

test('a newer attach on the same channel also supersedes an older pending RPC', async () => {
  const f = fixture()
  try {
    f.attach()
    f.attach()
    const current = await f.resolve(1)
    current.frame()
    await turn()
    const obsolete = await f.resolve(0)
    assert.equal(obsolete.closed, true)
    assert.equal(current.closed, false)
    assert.equal(f.control.messages.filter((message: any) => message.type === 'ready').length, 1)
  } finally {
    f.bridge.dispose()
  }
})

test('unexpected current attach failures still reach the renderer', async () => {
  const f = fixture()
  try {
    f.attach()
    f.pending[0]!.reject(new Error('current attach failed'))
    await turn()
    assert.deepEqual(f.control.messages, [
      { type: 'error', sessionId: 's', error: 'current attach failed' },
    ])
  } finally {
    f.bridge.dispose()
  }
})

test('output posts exact-sized bytes: pooled views are copied, owned exact buffers are not', async () => {
  const f = fixture()
  try {
    f.attach()
    const stream = await f.resolve(0)
    // Small Node Buffers are views into a shared pool; posting their backing buffer would expose
    // unrelated bytes, so the bridge must copy them. Exact, private buffers post as they are.
    const pooled = Buffer.alloc(64, 0x7a).subarray(8, 21)
    pooled.write('pooled output')
    // Buffer.from(typedArray) may also land in the pool (Node >= 24.21); build it as pettyd-stream does.
    const owned = Buffer.allocUnsafeSlow(8192).fill(66)
    assert.ok(pooled.buffer.byteLength > pooled.byteLength)
    assert.equal(owned.byteOffset === 0 && owned.buffer.byteLength === owned.byteLength, true)
    for (const [seq, payload] of [pooled, owned].entries()) {
      stream.emit('frame', {
        sessionId: 's',
        kind: PettydStreamFrameKind.Output,
        seq: seq + 1,
        payload,
      })
    }
    const posted = f.channel.messages as Array<{ type: string; seq: number; data: ArrayBuffer }>
    assert.deepEqual(
      posted.map((message) => [message.type, message.seq]),
      [
        ['output', 1],
        ['output', 2],
      ],
    )
    assert.notEqual(posted[0]!.data, pooled.buffer)
    assert.equal(Buffer.from(posted[0]!.data).toString(), 'pooled output')
    assert.equal(posted[1]!.data, owned.buffer)
    assert.equal(posted[1]!.data.byteLength, 8192)
  } finally {
    f.bridge.dispose()
  }
})

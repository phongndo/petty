import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import net from 'node:net'
import { fileURLToPath } from 'node:url'
import {
  PETTYD_CONTROL_CAPABILITIES,
  PETTYD_CONTROL_PROTOCOL_VERSION,
} from '@petty/shared/pettyd-protocol'
import { PettydClient, type PettydControlResponse } from './pettyd-client'

type ControlRequest = Record<string, unknown>

const streamDiagnostics = {
  active_subscribers: 0,
  pending_output_sessions: 0,
  pending_output_frames: 0,
  pending_output_bytes: 0,
  input_frames_total: 0,
  input_bytes_total: 0,
  output_frames_total: 7,
  output_bytes_total: 1234,
  slow_subscriber_drops_total: 0,
  pending_output_dropped_frames_total: 1,
  pending_output_dropped_bytes_total: 256,
  pending_output_truncated_bytes_total: 512,
}

const controlDiagnostics = {
  request_count: 3,
  failure_count: 1,
  last_request_type: 'create',
  last_trace_id: 'trace-create',
  last_duration_ms: 4,
  last_ok: true,
  last_recorded_at_ms: 1_700_000_000_000,
}

const fixtureRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../..',
  'packages/shared/fixtures/pettyd-protocol',
)

function readJsonFixture(name: string): ControlRequest {
  return JSON.parse(readFileSync(resolve(fixtureRoot, name), 'utf8').trim()) as ControlRequest
}

function pingResponse(overrides: Partial<PettydControlResponse> = {}): PettydControlResponse {
  return {
    id: 'ping-test',
    ok: true,
    status: 'ok',
    protocol_version: PETTYD_CONTROL_PROTOCOL_VERSION,
    daemon_version: 'test-daemon',
    capabilities: [...PETTYD_CONTROL_CAPABILITIES],
    stream_diagnostics: streamDiagnostics,
    control_diagnostics: controlDiagnostics,
    ...overrides,
  }
}

async function withSocketPath<T>(run: (socketPath: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'petty-pettyd-client-'))
  try {
    return await run(join(dir, 'pettyd.sock'))
  } finally {
    rmSync(dir, { force: true, recursive: true })
  }
}

async function withControlServer<T>(
  handler: (request: ControlRequest) => PettydControlResponse | 'close',
  run: (socketPath: string) => Promise<T>,
): Promise<T> {
  return withSocketPath(async (socketPath) => {
    const server = net.createServer((socket) => {
      let pending = ''
      socket.on('data', (chunk) => {
        pending += chunk.toString('utf8')
        const newline = pending.indexOf('\n')
        if (newline === -1) return
        const line = pending.slice(0, newline)
        pending = pending.slice(newline + 1)
        const request = JSON.parse(line) as ControlRequest
        const response = handler(request)
        if (response === 'close') {
          socket.destroy()
          return
        }
        socket.end(
          `${JSON.stringify({
            ...response,
            ...(typeof request.traceId === 'string' ? { trace_id: request.traceId } : {}),
          })}\n`,
        )
      })
    })

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, () => {
        server.off('error', reject)
        resolve()
      })
    })

    try {
      return await run(socketPath)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
}

function testClient(socketPath: string): PettydClient {
  return new PettydClient({
    socketPath,
    connectTimeoutMs: 50,
    controlResponseTimeoutMs: 100,
    startTimeoutMs: 100,
    healthCheckIntervalMs: 0,
    restartBackoffMs: 10,
    detachDaemon: false,
  })
}

test('PettydClient lifecycle diagnostics report absent socket without spawning', async () => {
  await withSocketPath(async (socketPath) => {
    const client = testClient(socketPath)
    try {
      const diagnostics = await client.refreshLifecycleDiagnostics()
      assert.equal(diagnostics.state, 'absent')
      assert.equal(diagnostics.daemonOwnership, 'none')
      assert.equal(diagnostics.recoveryAction, 'start-daemon')
      assert.match(diagnostics.lastReason ?? '', /^ping-failed:/)
      assert.equal(diagnostics.startInFlight, false)
      assert.equal(diagnostics.restartScheduled, false)
      assert.equal(diagnostics.timing.clientCreatedAt, diagnostics.transitions[0]?.at)
      assert.ok(diagnostics.timing.lastPingStartedAt)
      const pingDurationMs = diagnostics.timing.lastPingDurationMs
      if (pingDurationMs === undefined) assert.fail('missing ping duration')
      assert.ok(pingDurationMs >= 0)
      assert.ok(diagnostics.timing.lastFailedPingAt)
    } finally {
      await client.dispose()
    }
  })
})

test('PettydClient lifecycle diagnostics report compatible external daemon and stream counters', async () => {
  await withControlServer(
    (request) => {
      assert.equal(request.type, 'ping')
      return pingResponse({ id: String(request.id ?? 'ping-test') })
    },
    async (socketPath) => {
      const client = testClient(socketPath)
      try {
        const diagnostics = await client.refreshLifecycleDiagnostics()
        assert.match(diagnostics.clientTraceId, /^pettyd-client-/)
        assert.equal(diagnostics.state, 'external-live')
        assert.equal(diagnostics.daemonOwnership, 'external')
        assert.equal(diagnostics.recoveryAction, 'reuse-external-daemon')
        assert.equal(diagnostics.daemonVersion, 'test-daemon')
        assert.equal(diagnostics.protocolVersion, PETTYD_CONTROL_PROTOCOL_VERSION)
        assert.deepEqual(diagnostics.capabilities, [...PETTYD_CONTROL_CAPABILITIES])
        assert.equal(diagnostics.streamDiagnostics?.outputBytesTotal, 1234)
        assert.equal(diagnostics.streamDiagnostics?.pendingOutputDroppedFramesTotal, 1)
        assert.equal(diagnostics.streamDiagnostics?.pendingOutputDroppedBytesTotal, 256)
        assert.equal(diagnostics.streamDiagnostics?.pendingOutputTruncatedBytesTotal, 512)
        assert.equal(diagnostics.daemonControlDiagnostics?.requestCount, 3)
        assert.equal(diagnostics.daemonControlDiagnostics?.failureCount, 1)
        assert.equal(diagnostics.daemonControlDiagnostics?.lastRequestType, 'create')
        assert.equal(diagnostics.daemonControlDiagnostics?.lastTraceId, 'trace-create')
        assert.equal(diagnostics.daemonControlDiagnostics?.lastDurationMs, 4)
        assert.equal(diagnostics.daemonControlDiagnostics?.lastOk, true)
        assert.equal(diagnostics.daemonControlDiagnostics?.lastRecordedAtMs, 1_700_000_000_000)
        assert.ok(diagnostics.timing.lastSuccessfulPingAt)
        const pingDurationMs = diagnostics.timing.lastPingDurationMs
        if (pingDurationMs === undefined) assert.fail('missing ping duration')
        assert.ok(pingDurationMs >= 0)
        assert.equal(diagnostics.timing.lastTransitionAt, diagnostics.transitions.at(-1)?.at)
      } finally {
        await client.dispose()
      }
    },
  )
})

test('PettydClient lifecycle recovery reuses compatible external daemons', async () => {
  await withControlServer(
    (request) => {
      assert.equal(request.type, 'ping')
      return pingResponse({ id: String(request.id ?? 'ping-test') })
    },
    async (socketPath) => {
      const client = testClient(socketPath)
      try {
        const diagnostics = await client.refreshLifecycleDiagnostics()
        assert.equal(diagnostics.recoveryAction, 'reuse-external-daemon')

        const recovered = await client.applyLifecycleRecovery('reuse-external-daemon')
        assert.equal(recovered.state, 'external-live')
        assert.equal(recovered.daemonOwnership, 'external')
        assert.equal(recovered.recoveryAction, 'reuse-external-daemon')
      } finally {
        await client.dispose()
      }
    },
  )
})

test('PettydClient lifecycle diagnostics report protocol version mismatch', async () => {
  await withControlServer(
    (request) => pingResponse({ id: String(request.id ?? 'ping-test'), protocol_version: 999 }),
    async (socketPath) => {
      const client = testClient(socketPath)
      try {
        const diagnostics = await client.refreshLifecycleDiagnostics()
        assert.equal(diagnostics.state, 'version-mismatch')
        assert.equal(diagnostics.daemonOwnership, 'external')
        assert.equal(diagnostics.recoveryAction, 'replace-incompatible-daemon')
        assert.equal(diagnostics.lastReason, 'ping-version-mismatch')
        assert.match(diagnostics.lastError ?? '', /protocol mismatch/)
      } finally {
        await client.dispose()
      }
    },
  )
})

test('PettydClient lifecycle recovery refuses to replace external incompatible daemons', async () => {
  await withControlServer(
    (request) => pingResponse({ id: String(request.id ?? 'ping-test'), protocol_version: 999 }),
    async (socketPath) => {
      const client = testClient(socketPath)
      try {
        const diagnostics = await client.refreshLifecycleDiagnostics()
        assert.equal(diagnostics.state, 'version-mismatch')
        assert.equal(diagnostics.daemonOwnership, 'external')
        assert.equal(diagnostics.recoveryAction, 'replace-incompatible-daemon')

        await assert.rejects(
          () => client.applyLifecycleRecovery('replace-incompatible-daemon'),
          /does not own a running daemon/,
        )
      } finally {
        await client.dispose()
      }
    },
  )
})

test('PettydClient lifecycle diagnostics report stale socket on malformed daemon response', async () => {
  await withControlServer(
    () => 'close',
    async (socketPath) => {
      const client = testClient(socketPath)
      try {
        const diagnostics = await client.refreshLifecycleDiagnostics()
        assert.equal(diagnostics.state, 'stale-socket')
        assert.equal(diagnostics.daemonOwnership, 'none')
        assert.equal(diagnostics.recoveryAction, 'clear-stale-socket-and-start')
        assert.equal(diagnostics.lastReason, 'ping-failed')
      } finally {
        await client.dispose()
      }
    },
  )
})

test('PettydClient records control request timing for successful daemon calls', async () => {
  await withControlServer(
    (request) => {
      if (request.type === 'ping') return pingResponse({ id: String(request.id ?? 'ping-test') })
      if (request.type === 'create') {
        return {
          id: String(request.id ?? 'create-test'),
          ok: true,
          session_id: String(request.sessionId ?? ''),
          stream_id: 'stream-test',
          status: 'live',
          pid: 123,
        }
      }
      return { id: String(request.id ?? 'unknown'), ok: false, error_message: 'unexpected request' }
    },
    async (socketPath) => {
      const client = testClient(socketPath)
      try {
        await client.createSession({
          sessionId: 'session-1',
          terminalId: 'terminal-1',
          cols: 80,
          rows: 24,
        })

        const diagnostics = client.getLifecycleDiagnostics()
        assert.equal(diagnostics.state, 'external-live')
        assert.equal(diagnostics.daemonOwnership, 'external')
        assert.equal(diagnostics.recoveryAction, 'reuse-external-daemon')
        assert.equal(diagnostics.controlRequestCount, 2)
        assert.equal(diagnostics.controlRequestFailureCount, 0)
        assert.equal(diagnostics.lastControlRequest?.type, 'create')
        assert.equal(
          diagnostics.lastControlRequest?.traceId,
          `${diagnostics.clientTraceId}:${diagnostics.lastControlRequest?.id}`,
        )
        assert.equal(
          diagnostics.lastControlRequest?.responseTraceId,
          diagnostics.lastControlRequest?.traceId,
        )
        assert.equal(diagnostics.lastControlRequest?.ok, true)
        assert.ok(diagnostics.lastControlRequest.durationMs >= 0)
        assert.ok(diagnostics.timing.lastSuccessfulPingAt)
      } finally {
        await client.dispose()
      }
    },
  )
})

test('PettydClient session maintenance response shapes match shared protocol fixtures', async () => {
  await withControlServer(
    (request) => {
      if (request.type === 'ping') return pingResponse({ id: String(request.id ?? 'ping-test') })
      if (
        request.type === 'create' ||
        request.type === 'resize' ||
        request.type === 'detach' ||
        request.type === 'kill'
      ) {
        return readJsonFixture('control-session-response.ndjson') as PettydControlResponse
      }
      if (request.type === 'clear-history') {
        return readJsonFixture('control-clear-history-response.ndjson') as PettydControlResponse
      }
      if (request.type === 'cleanup') {
        return readJsonFixture('control-cleanup-response.ndjson') as PettydControlResponse
      }
      if (request.type === 'configure-persistence') {
        return readJsonFixture(
          'control-configure-persistence-response.ndjson',
        ) as PettydControlResponse
      }
      return {
        id: String(request.id ?? 'unexpected'),
        ok: false,
        error_code: 'invalid-response',
        error_message: 'unexpected request',
      }
    },
    async (socketPath) => {
      const client = testClient(socketPath)
      try {
        const create = await client.createSession({
          sessionId: 'session-fixture',
          terminalId: 'terminal-fixture',
          cols: 80,
          rows: 24,
          cwd: '/tmp/petty',
        })
        assert.equal(create.session_id, 'session-fixture')
        assert.equal(create.status, 'live')
        assert.equal(create.cwd, '/tmp/petty')
        assert.equal(create.cols, 80)
        assert.equal(create.rows, 24)
        assert.equal(create.last_seq, 0)
        assert.equal(create.attach_kind, 'live')

        const resize = await client.resizeSession('session-fixture', 80, 24)
        assert.equal(resize.session_id, 'session-fixture')
        assert.equal(resize.status, 'live')

        await client.detachSession('session-fixture')
        await client.killSession('session-fixture')

        const clearHistory = await client.clearHistory(['session-fixture'])
        assert.equal(clearHistory.removed_sessions, 1)
        assert.equal(clearHistory.removed_bytes, 2048)

        const cleanup = await client.cleanupSessions({
          retainDays: 30,
          maxSessionBytes: 4096,
          activeSessionIds: ['session-fixture'],
        })
        assert.equal(cleanup.removed_sessions, 2)
        assert.equal(cleanup.removed_bytes, 4096)

        const persistence = await client.configurePersistence({
          enabled: true,
          persistInput: false,
        })
        assert.equal((persistence as Record<string, unknown>).persistence_enabled, true)
        assert.equal((persistence as Record<string, unknown>).persist_input, false)
      } finally {
        await client.dispose()
      }
    },
  )
})

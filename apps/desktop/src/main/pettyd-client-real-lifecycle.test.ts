import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { resolvePettyStoragePaths } from '@petty/shared/storage-path'
import { PettydClient } from './pettyd-client'

const testDir = dirname(fileURLToPath(import.meta.url))
const desktopRoot = resolve(testDir, '../..')
const repoRoot = resolve(desktopRoot, '../..')

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function terminateProcess(pid: number): Promise<void> {
  if (!processIsRunning(pid)) return
  process.kill(pid, 'SIGTERM')
  await waitFor(`process ${pid} exit`, () => !processIsRunning(pid), 3000).catch(() => {
    if (processIsRunning(pid)) process.kill(pid, 'SIGKILL')
  })
}

function findPettydBinary(): string | null {
  const exeName = process.platform === 'win32' ? 'pettyd.exe' : 'pettyd'
  const candidates = [
    process.env.PETTYD_PATH,
    resolve(desktopRoot, 'out/bin', exeName),
    resolve(repoRoot, 'apps/daemon/zig-out/bin', exeName),
  ].filter(Boolean) as string[]

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

async function waitFor(
  description: string,
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await sleep(50)
  }
  throw new Error(`Timed out waiting for ${description}`)
}

test(
  'PettydClient restarts an owned real daemon after process exit',
  { skip: process.platform === 'win32' ? 'pettyd lifecycle integration is POSIX-only' : false },
  async (context) => {
    const binaryPath = findPettydBinary()
    if (!binaryPath) {
      context.skip('pettyd binary not found; run pnpm build first')
      return
    }

    const previousHome = process.env.HOME
    const previousPettydPath = process.env.PETTYD_PATH
    const previousAdapterDir = process.env.PETTYD_ADAPTER_DIR
    const home = mkdtempSync(resolve(tmpdir(), 'petty-real-lifecycle-'))
    process.env.HOME = home
    process.env.PETTYD_PATH = binaryPath
    process.env.PETTYD_ADAPTER_DIR = resolve(desktopRoot, 'out/adapters')

    const client = new PettydClient({
      socketPath: resolvePettyStoragePaths(home).socket,
      connectTimeoutMs: 100,
      controlResponseTimeoutMs: 1000,
      startTimeoutMs: 5000,
      healthCheckIntervalMs: 0,
      restartBackoffMs: 5000,
      detachDaemon: false,
    })

    try {
      await client.ensureRunning()
      const initial = client.getLifecycleDiagnostics()
      assert.equal(initial.state, 'owned-live')
      assert.equal(initial.detachDaemon, false)
      assert.equal(initial.daemonOwnership, 'owned-attached')
      assert.equal(initial.recoveryAction, 'none')
      assert.ok(initial.spawnedPid, 'expected owned daemon pid')

      process.kill(initial.spawnedPid, 'SIGTERM')

      await waitFor('crash lifecycle state', () => {
        const diagnostics = client.getLifecycleDiagnostics()
        return (
          diagnostics.state === 'crashed' &&
          diagnostics.recoveryAction === 'restart-owned-daemon' &&
          diagnostics.restartScheduled
        )
      })

      const recovered = await client.applyLifecycleRecovery('restart-owned-daemon')
      assert.equal(recovered.state, 'owned-live')
      assert.equal(recovered.daemonOwnership, 'owned-attached')
      assert.equal(recovered.recoveryAction, 'none')
      assert.equal(recovered.restartScheduled, false)
      assert.notEqual(recovered.spawnedPid, initial.spawnedPid)

      await waitFor('restarted owned daemon', () => {
        const diagnostics = client.getLifecycleDiagnostics()
        return diagnostics.state === 'owned-live' && diagnostics.spawnedPid !== initial.spawnedPid
      })

      const restarted = client.getLifecycleDiagnostics()
      assert.equal(restarted.state, 'owned-live')
      assert.equal(restarted.daemonOwnership, 'owned-attached')
      assert.equal(restarted.recoveryAction, 'none')
      assert.notEqual(restarted.spawnedPid, initial.spawnedPid)
      assert.ok(restarted.transitions.some((event) => event.state === 'crashed'))
      assert.ok(restarted.controlRequestCount >= 2)
    } finally {
      await client.dispose()
      rmSync(home, { recursive: true, force: true })
      if (previousHome === undefined) delete process.env.HOME
      else process.env.HOME = previousHome
      if (previousPettydPath === undefined) delete process.env.PETTYD_PATH
      else process.env.PETTYD_PATH = previousPettydPath
      if (previousAdapterDir === undefined) delete process.env.PETTYD_ADAPTER_DIR
      else process.env.PETTYD_ADAPTER_DIR = previousAdapterDir
    }
  },
)

test(
  'PettydClient dispose preserves a detached daemon for app quit semantics',
  { skip: process.platform === 'win32' ? 'pettyd lifecycle integration is POSIX-only' : false },
  async (context) => {
    const binaryPath = findPettydBinary()
    if (!binaryPath) {
      context.skip('pettyd binary not found; run pnpm build first')
      return
    }

    const previousHome = process.env.HOME
    const previousPettydPath = process.env.PETTYD_PATH
    const previousAdapterDir = process.env.PETTYD_ADAPTER_DIR
    const home = mkdtempSync(resolve(tmpdir(), 'petty-detached-quit-'))
    process.env.HOME = home
    process.env.PETTYD_PATH = binaryPath
    process.env.PETTYD_ADAPTER_DIR = resolve(desktopRoot, 'out/adapters')

    const client = new PettydClient({
      socketPath: resolvePettyStoragePaths(home).socket,
      connectTimeoutMs: 100,
      controlResponseTimeoutMs: 1000,
      startTimeoutMs: 5000,
      healthCheckIntervalMs: 0,
      restartBackoffMs: 50,
      detachDaemon: true,
    })
    let spawnedPid: number | undefined

    try {
      await client.ensureRunning()
      const initial = client.getLifecycleDiagnostics()
      assert.equal(initial.state, 'owned-live')
      assert.equal(initial.detachDaemon, true)
      assert.equal(initial.daemonOwnership, 'owned-detached')
      assert.equal(initial.recoveryAction, 'none')
      assert.ok(initial.spawnedPid, 'expected detached daemon pid')
      spawnedPid = initial.spawnedPid

      await client.dispose()

      const disposed = client.getLifecycleDiagnostics()
      assert.equal(disposed.state, 'disposed')
      assert.equal(disposed.detachDaemon, true)
      assert.equal(disposed.daemonOwnership, 'released-detached')
      assert.equal(disposed.recoveryAction, 'keep-detached-daemon')
      assert.equal(disposed.releasedDetachedPid, spawnedPid)
      assert.ok(
        processIsRunning(spawnedPid),
        'detached daemon should survive client dispose so PTYs can survive Electron quit',
      )
    } finally {
      if (spawnedPid) await terminateProcess(spawnedPid)
      await client.dispose().catch(() => {})
      rmSync(home, { recursive: true, force: true })
      if (previousHome === undefined) delete process.env.HOME
      else process.env.HOME = previousHome
      if (previousPettydPath === undefined) delete process.env.PETTYD_PATH
      else process.env.PETTYD_PATH = previousPettydPath
      if (previousAdapterDir === undefined) delete process.env.PETTYD_ADAPTER_DIR
      else process.env.PETTYD_ADAPTER_DIR = previousAdapterDir
    }
  },
)

test(
  'PettydClient records failure and restarts when owned daemon exits mid-request',
  {
    skip:
      process.platform !== 'darwin'
        ? 'workspace.ports mid-request crash test relies on macOS lsof timing'
        : false,
  },
  async (context) => {
    const binaryPath = findPettydBinary()
    if (!binaryPath) {
      context.skip('pettyd binary not found; run pnpm build first')
      return
    }

    const previousHome = process.env.HOME
    const previousPettydPath = process.env.PETTYD_PATH
    const previousAdapterDir = process.env.PETTYD_ADAPTER_DIR
    const home = mkdtempSync(resolve(tmpdir(), 'petty-mid-request-'))
    process.env.HOME = home
    process.env.PETTYD_PATH = binaryPath
    process.env.PETTYD_ADAPTER_DIR = resolve(desktopRoot, 'out/adapters')

    const client = new PettydClient({
      socketPath: resolvePettyStoragePaths(home).socket,
      connectTimeoutMs: 100,
      controlResponseTimeoutMs: 5000,
      startTimeoutMs: 5000,
      healthCheckIntervalMs: 0,
      restartBackoffMs: 50,
      detachDaemon: false,
    })

    try {
      await client.ensureRunning()
      const initial = client.getLifecycleDiagnostics()
      assert.equal(initial.state, 'owned-live')
      assert.equal(initial.daemonOwnership, 'owned-attached')
      assert.equal(initial.recoveryAction, 'none')
      assert.ok(initial.spawnedPid, 'expected owned daemon pid')

      await sleep(100)
      process.kill(initial.spawnedPid, 'SIGTERM')

      await waitFor('crash lifecycle state after mid-request exit', () => {
        const diagnostics = client.getLifecycleDiagnostics()
        return (
          diagnostics.state === 'crashed' &&
          diagnostics.recoveryAction === 'restart-owned-daemon' &&
          diagnostics.restartScheduled
        )
      })

      await waitFor('restarted owned daemon after mid-request exit', () => {
        const diagnostics = client.getLifecycleDiagnostics()
        return diagnostics.state === 'owned-live' && diagnostics.spawnedPid !== initial.spawnedPid
      })
    } finally {
      await client.dispose()
      rmSync(home, { recursive: true, force: true })
      if (previousHome === undefined) delete process.env.HOME
      else process.env.HOME = previousHome
      if (previousPettydPath === undefined) delete process.env.PETTYD_PATH
      else process.env.PETTYD_PATH = previousPettydPath
      if (previousAdapterDir === undefined) delete process.env.PETTYD_ADAPTER_DIR
      else process.env.PETTYD_ADAPTER_DIR = previousAdapterDir
    }
  },
)

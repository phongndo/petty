import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const tsx = createRequire(import.meta.url).resolve('tsx/cli')

async function runScript(args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  const child = spawn(process.execPath, [tsx, ...args], {
    ...options,
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let stderr = ''
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk))
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  })
  return { exitCode, stderr }
}

async function installerFixture(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'tau-electron-installer-'))
  try {
    const electron = join(root, 'apps/desktop/node_modules/electron')
    await mkdir(join(electron, 'dist'), { recursive: true })
    await mkdir(join(root, 'scripts'), { recursive: true })
    // Match the repository: scripts are ES modules with top-level await.
    await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module' }))
    await cp(
      resolve(import.meta.dirname, 'electron-install.ts'),
      join(root, 'scripts/electron-install.ts'),
    )
    // A separate root copy must not distract the installer from the desktop runtime.
    const rootElectron = join(root, 'node_modules/electron')
    await mkdir(rootElectron, { recursive: true })
    await writeFile(
      join(rootElectron, 'package.json'),
      JSON.stringify({ name: 'electron', version: '1.0.0' }),
    )
    await writeFile(
      join(electron, 'package.json'),
      JSON.stringify({ name: 'electron', version: '1.0.0' }),
    )
    // Use the Linux layout on every host; no platform binaries are actually executed.
    await writeFile(join(electron, 'dist/electron'), 'desktop fixture')
    await writeFile(join(electron, 'dist/version'), '1.0.0')
    await writeFile(join(electron, 'path.txt'), 'electron')
    await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function runInstaller(root: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_INSTALL_PLATFORM: 'linux' }
  // The fixture is not an ELF; do not try to patch it in a Nix shell.
  delete env.NIX_CC
  delete env.ELECTRON_OVERRIDE_DIST_PATH
  return runScript([join(root, 'scripts/electron-install.ts')], { cwd: root, env })
}

test('tooling benchmark refuses to label pnpm workspace scripts as a Bun baseline', async () => {
  const { exitCode, stderr } = await runScript([
    resolve(import.meta.dirname, 'bench-tooling.ts'),
    '--manager',
    'bun',
    '--cwd',
    resolve(import.meta.dirname, '..'),
    '--output',
    join(tmpdir(), 'tau-should-not-write-benchmark.json'),
  ])
  assert.notEqual(exitCode, 0)
  assert.ok(stderr.includes('Measure the matching revision'))
})

test('Electron installer leaves an already complete runtime alone without a downloader', async () => {
  await installerFixture(async (root) => {
    assert.deepEqual(await runInstaller(root), { exitCode: 0, stderr: '' })
    assert.equal(
      await readFile(join(root, 'apps/desktop/node_modules/electron/dist/electron'), 'utf8'),
      'desktop fixture',
    )
    assert.equal(existsSync(join(root, 'node_modules/electron/dist/electron')), false)
  })
})

test('Electron installer rejects a stale workspace-local Electron version', async () => {
  await installerFixture(async (root) => {
    await writeFile(
      join(root, 'node_modules/electron/package.json'),
      JSON.stringify({ name: 'electron', version: '2.0.0' }),
    )
    const result = await runInstaller(root)
    assert.notEqual(result.exitCode, 0)
    assert.ok(result.stderr.includes('Electron version mismatch: desktop 1.0.0'))
  })
})

test('Electron installer resolves the downloader relative to Electron and propagates repair failures', async () => {
  await installerFixture(async (root) => {
    const electron = join(root, 'apps/desktop/node_modules/electron')
    await rm(join(electron, 'dist/electron'))
    const downloader = join(electron, 'node_modules/@electron/get')
    await mkdir(downloader, { recursive: true })
    await writeFile(
      join(downloader, 'package.json'),
      JSON.stringify({ name: '@electron/get', main: 'index.js' }),
    )
    await writeFile(
      join(downloader, 'index.js'),
      'exports.downloadArtifact = async () => { throw new Error("fixture download failed") }',
    )
    const result = await runInstaller(root)
    assert.notEqual(result.exitCode, 0)
    assert.ok(result.stderr.includes('fixture download failed'))
  })
})

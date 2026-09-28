import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)
const electronPath = require('electron') as string
const [entry, ...args] = process.argv.slice(2)

if (!entry) {
  console.error('Usage: tsx bench/run-electron.ts <entry.ts> [...args]')
  process.exit(1)
}

// Compile with esbuild, execute with Electron.
// Keep the output under the desktop workspace so external npm imports (and renderer
// require calls) resolve against the same node_modules as the application.
const cache = resolve(import.meta.dirname, '../.bench-cache')
await mkdir(cache, { recursive: true })
const outdir = await mkdtemp(resolve(cache, 'electron-'))
let exitCode = 1
try {
  await build({
    entryPoints: [resolve(entry)],
    outfile: resolve(outdir, 'entry.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    sourcemap: 'inline',
  })

  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  // Benchmarks need neither a persistent Chromium profile nor macOS Keychain access.
  // Keychain permission prompts can otherwise leave Electron blocked during shutdown.
  const electronArgs = [
    resolve(outdir, 'entry.mjs'),
    `--user-data-dir=${resolve(outdir, 'profile')}`,
    ...(process.platform === 'darwin' ? ['--use-mock-keychain'] : []),
    // GitHub's Linux runner cannot install Electron's SUID helper from node_modules.
    // These disposable test windows only load local fixtures; the desktop app does not use this flag.
    ...(process.platform === 'linux' && process.env.CI === 'true' ? ['--no-sandbox'] : []),
    ...args,
  ]
  const child = spawn(electronPath, electronArgs, { stdio: 'inherit', env })
  const interrupt = () => child.kill('SIGINT')
  const terminate = () => child.kill('SIGTERM')
  process.on('SIGINT', interrupt)
  process.on('SIGTERM', terminate)
  try {
    exitCode = await new Promise<number>((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', (code) => resolve(code ?? 1))
    })
  } finally {
    process.off('SIGINT', interrupt)
    process.off('SIGTERM', terminate)
  }
} finally {
  await rm(outdir, { recursive: true, force: true })
}
process.exitCode = exitCode

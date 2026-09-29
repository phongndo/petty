#!/usr/bin/env tsx
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import type { SpawnSyncOptions, SpawnSyncReturns } from 'node:child_process'
import { GHOSTTY_REVISION } from './ghostty-source'

type RunOptions = {
  cwd?: string
  stdio?: SpawnSyncOptions['stdio']
  env?: NodeJS.ProcessEnv
}

type ZonDependency = {
  url: string
  hash: string
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const daemonRoot = resolve(repoRoot, 'apps/daemon')
const [command = 'build', ...rawArgs] = process.argv.slice(2)
const passthroughArgs = rawArgs[0] === '--' ? rawArgs.slice(1) : rawArgs
const optimizeMode = process.env.PETTYD_OPTIMIZE ?? (command === 'build' ? 'ReleaseFast' : 'Debug')
const validOptimizeModes = new Set(['Debug', 'ReleaseFast', 'ReleaseSmall'])
if (!validOptimizeModes.has(optimizeMode)) fail(`Invalid PETTYD_OPTIMIZE mode: ${optimizeMode}`)

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

function run(
  command: string,
  args: readonly string[],
  options: RunOptions = {},
): SpawnSyncReturns<Buffer> {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? daemonRoot,
    stdio: options.stdio ?? 'inherit',
    env: options.env ?? process.env,
  })
  if (result.error) fail(result.error.message)
  if (result.status !== 0) process.exit(result.status ?? 1)
  return result
}

function runForStatus(
  command: string,
  args: readonly string[],
  options: RunOptions = {},
): SpawnSyncReturns<Buffer> {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? daemonRoot,
    stdio: options.stdio ?? 'inherit',
    env: options.env ?? process.env,
  })
  if (result.error) throw result.error
  return result
}

function exitFromRunResult(result: SpawnSyncReturns<Buffer>): void {
  if (result.status !== 0) process.exit(result.status ?? 1)
}

function output(command: string, args: readonly string[], cwd = daemonRoot): string {
  const result = spawnSync(command, args, {
    cwd,
    stdio: ['ignore', 'pipe', 'inherit'],
    encoding: 'utf8',
  })
  if (result.error) fail(result.error.message)
  if (result.status !== 0) process.exit(result.status ?? 1)
  return result.stdout.trim()
}

function assertZigVersion(): string {
  const version = output('zig', ['version'])
  if (version !== '0.16.0') {
    fail(`pettyd requires Zig 0.16.0; found ${version}. Run inside nix develop`)
  }
  return version
}

function ensureGhosttyNative(): string {
  const artifactDir = resolve(daemonRoot, '.ghostty-vt')
  const archive = resolve(artifactDir, 'libghostty-vt.a')
  const revisionFile = resolve(artifactDir, 'revision')
  if (
    !existsSync(archive) ||
    !existsSync(resolve(artifactDir, 'include/ghostty/vt.h')) ||
    !existsSync(revisionFile) ||
    readFileSync(revisionFile, 'utf8').trim() !== GHOSTTY_REVISION
  ) {
    // Reuse this process's tsx loader flags for the sibling TypeScript script.
    run(process.execPath, [...process.execArgv, 'scripts/build-ghostty-vt-native.ts'], {
      cwd: repoRoot,
    })
  }
  if (!existsSync(archive)) fail('Ghostty native archive is missing after build')
  return archive
}

function zonDependency(zonPath: string, name: string): ZonDependency {
  const zon = readFileSync(zonPath, 'utf8')
  const pattern = new RegExp(
    `\\.${name}\\s*=\\s*\\.\\{[\\s\\S]*?\\.url\\s*=\\s*"([^"]+)"[\\s\\S]*?\\.hash\\s*=\\s*"([^"]+)"`,
    'u',
  )
  const match = zon.match(pattern)
  if (!match) fail(`Could not find .${name} dependency in ${zonPath}`)
  return { url: match[1], hash: match[2] }
}

function ensurePackage(dep: ZonDependency): string {
  // Zig 0.16 `fetch` caches the archive at p/<hash>.tar.gz; `build --fetch=all`
  // expands the full dependency tree into this project's zig-pkg directory.
  const packagePath = resolve(daemonRoot, 'zig-pkg', dep.hash)
  if (!existsSync(packagePath)) {
    const envOutput = output('zig', ['env'])
    const globalCacheDir =
      tryParseJson(envOutput)?.global_cache_dir ??
      envOutput.match(/\.global_cache_dir\s*=\s*"([^"]+)"/)?.[1]
    if (!globalCacheDir) fail('Could not determine Zig global cache dir from `zig env`')
    // Zig's ZIP fetcher requires tmp/ when the cache is overridden (as in CI).
    mkdirSync(resolve(globalCacheDir, 'tmp'), { recursive: true })
    run('zig', ['build', '--fetch=all'])
  }
  if (!existsSync(packagePath)) fail(`Expected Zig package at ${packagePath}`)
  return packagePath
}

function writeFileIfChanged(path: string, contents: string): void {
  if (existsSync(path) && readFileSync(path, 'utf8') === contents) return
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, contents)
}

function tryParseJson(value: string): { global_cache_dir?: string } | null {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function darwinTarget(): string {
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64'
  return `${arch}-macos.15.0`
}

function darwinBuildOptionsPath(): string {
  const cacheDir = resolve(daemonRoot, '.zig-cache')
  mkdirSync(cacheDir, { recursive: true })
  const path = resolve(cacheDir, 'pettyd-build-options.zig')
  writeFileIfChanged(path, 'pub const vt_backend = "ghostty_native";\n')
  return path
}

function targetArgs(): string[] {
  if (process.platform !== 'darwin') return []
  return ['-target', darwinTarget()]
}

function directCompileArgs({
  root,
  binPath,
}: {
  root: 'main' | 'root'
  binPath?: string
}): string[] {
  const zigSqlite = zonDependency(resolve(daemonRoot, 'build.zig.zon'), 'sqlite')
  const zigSqlitePath = ensurePackage(zigSqlite)
  const sqliteAmalgamation = zonDependency(resolve(zigSqlitePath, 'build.zig.zon'), 'sqlite')
  const sqliteAmalgamationPath = ensurePackage(sqliteAmalgamation)
  const buildOptionsPath = darwinBuildOptionsPath()
  const ghosttyArchive = ensureGhosttyNative()

  const args = [
    root === 'main' ? 'build-exe' : 'test',
    ...targetArgs(),
    '-D',
    'SQLITE_ENABLE_FTS5',
    '-D',
    'SQLITE_THREADSAFE=1',
    resolve(sqliteAmalgamationPath, 'sqlite3.c'),
    resolve(zigSqlitePath, 'c/workaround.c'),
  ]

  if (binPath) args.push(`-femit-bin=${binPath}`)
  args.push(`-O${optimizeMode}`)

  if (root === 'main') {
    args.push(
      '--dep',
      'pettyd',
      '-Mroot=src/main.zig',
      '--dep',
      'sqlite',
      '--dep',
      'build_options=pettyd_build_options',
      '-Mpettyd=src/root.zig',
    )
  } else {
    args.push(
      '--dep',
      'sqlite',
      '--dep',
      'build_options=pettyd_build_options',
      '-Mroot=src/root.zig',
    )
  }

  args.push(
    '-I',
    resolve(zigSqlitePath, 'c'),
    '-I',
    sqliteAmalgamationPath,
    `-Msqlite=${resolve(zigSqlitePath, 'sqlite.zig')}`,
    `-Mpettyd_build_options=${buildOptionsPath}`,
    '-I',
    resolve(daemonRoot, '.ghostty-vt/include'),
    ghosttyArchive,
    '-lc',
  )
  if (process.platform === 'linux') args.push('-lutil')

  return args
}

function buildDirect(): string {
  const binDir = resolve(daemonRoot, 'zig-out/bin')
  mkdirSync(binDir, { recursive: true })
  const exeName = process.platform === 'win32' ? 'pettyd.exe' : 'pettyd'
  const binPath = resolve(binDir, exeName)
  run('zig', directCompileArgs({ root: 'main', binPath }))
  if (optimizeMode !== 'Debug' && process.platform === 'darwin') {
    const symbolsDir = resolve(daemonRoot, 'zig-out/symbols')
    mkdirSync(symbolsDir, { recursive: true })
    runForStatus('dsymutil', [binPath, '-o', resolve(symbolsDir, `${exeName}.dSYM`)], {
      cwd: daemonRoot,
    })
    runForStatus('strip', ['-x', binPath], { cwd: daemonRoot })
  }
  return binPath
}

function withTemporaryHome<T>(callback: (home: string) => T): T {
  const home = mkdtempSync(resolve(tmpdir(), 'pettyd-home-'))
  try {
    return callback(home)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

function leakCheckEnv(home: string): NodeJS.ProcessEnv {
  return { ...process.env, HOME: home, PETTYD_DEBUG_ALLOC: '1' }
}

function runLeakCheck(command: string, args: readonly string[], options: RunOptions = {}): void {
  const result = (() => {
    try {
      return withTemporaryHome((home) => {
        return runForStatus(command, args, {
          ...options,
          env: leakCheckEnv(home),
        })
      })
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err))
    }
  })()
  exitFromRunResult(result)
}

function testAndBuildDirect(): void {
  const cacheDir = resolve(daemonRoot, '.zig-cache')
  mkdirSync(cacheDir, { recursive: true })
  run('zig', directCompileArgs({ root: 'root', binPath: resolve(cacheDir, 'pettyd-root-test') }))
  run('zig', directCompileArgs({ root: 'main', binPath: resolve(cacheDir, 'pettyd-main-test') }))
}

assertZigVersion()

if (process.env.PETTYD_SKIP_NATIVE === '1') {
  switch (command) {
    case 'build':
    case 'test':
    case 'check':
    case 'leak-check':
      console.warn(`Skipping pettyd ${command}; PETTYD_SKIP_NATIVE=1`)
      process.exit(0)
    case 'run':
      fail('Cannot run pettyd when PETTYD_SKIP_NATIVE=1')
    default:
      fail(`Unknown pettyd zig command: ${command}`)
  }
}

if (process.platform === 'win32') {
  switch (command) {
    case 'build':
    case 'test':
    case 'check':
    case 'leak-check':
      console.warn(`Skipping pettyd ${command} on Windows; pettyd is POSIX-only`)
      process.exit(0)
    case 'run':
      fail('Cannot run pettyd on Windows; pettyd is POSIX-only')
    default:
      fail(`Unknown pettyd zig command: ${command}`)
  }
}

ensureGhosttyNative()

if (process.platform !== 'darwin' || process.env.PETTYD_USE_ZIG_BUILD === '1') {
  switch (command) {
    case 'build':
      run('zig', [
        'build',
        `-Doptimize=${optimizeMode}`,
        ...(optimizeMode === 'Debug' ? [] : ['-Dstrip=true']),
      ])
      break
    case 'test':
      run('zig', ['build', 'test'])
      break
    case 'run':
      run('zig', ['build', 'run', '--', ...passthroughArgs])
      break
    case 'check':
      run('zig', ['build', 'run', '--', '--check'])
      break
    case 'leak-check':
      runLeakCheck('zig', ['build', 'run', '--', '--check'])
      break
    default:
      fail(`Unknown pettyd zig command: ${command}`)
  }
  process.exit(0)
}

switch (command) {
  case 'build':
    buildDirect()
    break
  case 'test':
    testAndBuildDirect()
    break
  case 'run': {
    const binaryPath = buildDirect()
    run(binaryPath, passthroughArgs, { cwd: daemonRoot })
    break
  }
  case 'check': {
    const binaryPath = buildDirect()
    run(binaryPath, ['--check'], { cwd: daemonRoot })
    break
  }
  case 'leak-check': {
    const binaryPath = buildDirect()
    runLeakCheck(binaryPath, ['--check'], { cwd: daemonRoot })
    break
  }
  default:
    fail(`Unknown pettyd zig command: ${command}`)
}

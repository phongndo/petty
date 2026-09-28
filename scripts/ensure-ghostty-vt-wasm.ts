#!/usr/bin/env tsx
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { GHOSTTY_WEB_ARTIFACT_ID } from './ghostty-source'

const publicDir = resolve(import.meta.dirname, '../apps/desktop/public')
const revision = resolve(publicDir, 'ghostty-vt.revision')
if (
  !existsSync(resolve(publicDir, 'ghostty-vt.wasm')) ||
  !existsSync(revision) ||
  readFileSync(revision, 'utf8').trim() !== GHOSTTY_WEB_ARTIFACT_ID
) {
  // Reuse this process's tsx loader flags for the sibling TypeScript script.
  execFileSync(process.execPath, [...process.execArgv, 'scripts/build-ghostty-vt-wasm.ts'], {
    cwd: resolve(import.meta.dirname, '..'),
    stdio: 'inherit',
  })
}

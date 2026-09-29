import { homedir } from 'node:os'
import { Schema } from 'effect'
import { SettingsDataSchema, type SettingsData } from '@petty/shared/session'
import { validateSettings } from '@petty/shared/preferences'
import { resolvePettyStoragePaths } from '@petty/shared/storage-path'
import { readJsonFile, writeJsonFile } from './file-store'

const settingsPath = resolvePettyStoragePaths(homedir()).settings

export async function readSettings(): Promise<SettingsData | null> {
  const data = await readJsonFile<unknown>(settingsPath)
  if (data === null) return null

  const decoded = Schema.decodeUnknownOption(SettingsDataSchema)(data)
  return decoded._tag === 'Some' ? decoded.value : null
}

export async function writeSettings(data: SettingsData): Promise<void> {
  const decoded = Schema.decodeUnknownOption(SettingsDataSchema)(data)
  if (decoded._tag === 'None') throw new Error('Invalid settings data')
  validateSettings(decoded.value)
  await writeJsonFile(settingsPath, decoded.value)
}

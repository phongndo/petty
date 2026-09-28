import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultSettings, resolveSettings, validateSettings } from '@tau/shared/preferences'
import { conflictingShortcut, findShortcut, parseBinding } from '../src/main/shortcuts'

test('legacy preferences preserve retention settings while gaining interface defaults', () => {
  const legacy = {
    version: 1,
    persistence: { enabled: false, retainDays: 7, maxSessionBytes: 1024, persistInput: true },
  }
  const value = resolveSettings(legacy)
  assert.equal(value.appearance?.sidebar, true)
  assert.deepEqual(value.persistence, legacy.persistence)
})

test('custom mux colors accept hex values and reject invalid CSS', () => {
  const settings = {
    ...defaultSettings,
    appearance: {
      ...defaultSettings.appearance!,
      customColors: { chrome: '#123456', accent: '#abcdef' },
    },
  }
  assert.doesNotThrow(() => validateSettings(settings))
  assert.throws(
    () =>
      validateSettings({
        ...settings,
        appearance: {
          ...settings.appearance,
          customColors: { chrome: 'url(https://example.com)' },
        },
      }),
    /Invalid custom mux color/,
  )
})

test('shortcuts match exact modifiers and allow unbinding', () => {
  assert.deepEqual(parseBinding('Ctrl+H'), {
    key: 'h',
    control: true,
    meta: false,
    alt: false,
    shift: false,
  })
  assert.equal(parseBinding('H'), null)
  assert.equal(parseBinding('Ctrl+Ctrl+H'), null)
  assert.equal(parseBinding('Mod+D')?.meta, true)
  const input = { key: 'd', control: false, meta: true, alt: false, shift: false }
  assert.equal(findShortcut(input, defaultSettings, 'darwin'), 'split-right')
  assert.equal(findShortcut({ ...input, key: 'b' }, defaultSettings, 'darwin'), 'toggle-sidebar')
  assert.equal(findShortcut({ ...input, key: 'w' }, defaultSettings, 'darwin'), 'close-pane')
  assert.equal(
    findShortcut({ ...input, key: 'w', shift: true }, defaultSettings, 'darwin'),
    'close-tab',
  )
  assert.equal(
    findShortcut({ ...input, control: true, meta: false }, defaultSettings, 'darwin'),
    null,
  )
  assert.equal(
    findShortcut(input, { ...defaultSettings, keybindings: { 'split-right': '' } }, 'darwin'),
    null,
  )
  assert.equal(findShortcut({ ...input, shift: true }, defaultSettings, 'darwin'), 'split-down')
  assert.equal(
    findShortcut(
      { key: 'x', control: true, meta: false, alt: false, shift: false },
      defaultSettings,
      'darwin',
    ),
    null,
  )
  assert.equal(
    findShortcut(
      { key: 'd', control: true, meta: false, alt: false, shift: true },
      defaultSettings,
      'linux',
    ),
    'split-right',
  )
  assert.equal(
    findShortcut(
      { key: 'Tab', control: true, meta: false, alt: false, shift: false },
      defaultSettings,
      'linux',
    ),
    'next-tab',
  )
  assert.equal(
    conflictingShortcut({ ...defaultSettings, keybindings: { search: 'Meta+D' } }, 'darwin'),
    'search',
  )
})

test('settings store validates writes and persists preferences', async () => {
  const home = await mkdtemp(join(tmpdir(), 'tau-settings-test-'))
  const previousHome = process.env.HOME
  // The store resolves its path from the home directory when first imported.
  process.env.HOME = home
  try {
    const { readSettings, writeSettings } = await import('../src/main/settings-store')
    assert.deepEqual(resolveSettings(await readSettings()).appearance, defaultSettings.appearance)
    await assert.rejects(writeSettings({ version: 'invalid' } as never), {
      message: /Invalid settings data/,
    })
    await writeSettings({
      ...defaultSettings,
      appearance: { theme: 'slate', accent: 'mint', sidebar: false },
    })
    assert.deepEqual(resolveSettings(await readSettings()).appearance, {
      theme: 'dark',
      accent: 'mint',
      sidebar: false,
      customColors: { chrome: '#293038', sidebar: '#282c31' },
    })
  } finally {
    process.env.HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

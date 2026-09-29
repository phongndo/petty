import assert from 'node:assert/strict'
import test from 'node:test'
import { Schema } from 'effect'
import { PANE_LAYOUT_VERSION, type PaneLayoutData } from '@petty/shared/session'
import { CreateSessionInputSchema } from '@petty/shared/pettyd-protocol'
import { collectPaneIds, normalizeSplitPercentages } from '@petty/shared/mux-graph'
import {
  selectMuxGraphSnapshot,
  selectPaneLayoutData,
  usePettyStore,
  workspaceFolderName,
} from '../src/renderer/state/store'
import { searchSettings } from '../src/renderer/ui/settings-search'

function resetStore(): void {
  usePettyStore.setState({
    tabs: [],
    workspaces: [],
    panes: [],
    activeTabId: null,
    activePaneId: null,
    graphRev: 0,
    graphExtensions: undefined,
  })
  // Force default shell via hydrate of empty invalid layout
  usePettyStore.getState().hydrateLayout({
    version: PANE_LAYOUT_VERSION,
    tabs: [],
    panes: [],
    activeTabId: null,
    activePaneId: null,
  })
}

test('fresh store opens a shell in a default workspace', () => {
  resetStore()
  const state = usePettyStore.getState()
  assert.equal(state.tabs.length, 1)
  assert.equal(state.panes.length, 1)
  assert.equal(state.panes[0]?.type, 'terminal')
  assert.equal(state.activeTabId, state.tabs[0]?.id)
  assert.equal(state.activePaneId, state.panes[0]?.id)
  assert.equal(state.workspaces[0]?.id, state.tabs[0]?.workspaceId)
  assert.equal('agentProvider' in (state.panes[0] as object), false)
})

test('create session schema does not require workspace or agent fields', () => {
  const decoded = Schema.decodeUnknownOption(CreateSessionInputSchema)({
    terminalId: 'term-1',
    cols: 80,
    rows: 24,
    cwd: '/tmp',
  })
  assert.equal(decoded._tag, 'Some')
  if (decoded._tag === 'Some') {
    assert.equal(decoded.value.terminalId, 'term-1')
    assert.equal('workspaceId' in decoded.value, false)
  }
})

test('tabs and splits retain their workspace', () => {
  resetStore()
  const store = usePettyStore.getState()
  store.newTab()
  store.splitActivePane('row')
  const state = usePettyStore.getState()
  assert.equal(state.tabs.length, 2)
  assert.equal(state.tabs[0]?.workspaceId, state.tabs[1]?.workspaceId)
  assert.ok(state.panes.length >= 2)
  const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId)
  assert.ok(activeTab)
  assert.equal(typeof activeTab.layout, 'object')
  const layout = selectPaneLayoutData(state)
  assert.equal(layout.version, PANE_LAYOUT_VERSION)
  assert.equal('workspaces' in layout, false)
})

test('workspace label follows the selected terminal folder across tabs and splits', () => {
  resetStore()
  let state = usePettyStore.getState()
  const workspace = state.workspaces[0]!
  const first = state.activePaneId!
  state.setPaneCwd(first, '/Users/me/project/')
  state = usePettyStore.getState()
  assert.equal(workspaceFolderName(state.workspaces[0]!, state.tabs, state.panes), 'project')
  state.newTab()
  state = usePettyStore.getState()
  assert.equal(workspaceFolderName(state.workspaces[0]!, state.tabs, state.panes), workspace.name)
  state.setPaneCwd(state.activePaneId!, '/tmp/another')
  state = usePettyStore.getState()
  assert.equal(workspaceFolderName(state.workspaces[0]!, state.tabs, state.panes), 'another')
  state.selectPane(first)
  state = usePettyStore.getState()
  assert.equal(workspaceFolderName(state.workspaces[0]!, state.tabs, state.panes), 'project')
  state.setPaneCwd(first, '/')
  state = usePettyStore.getState()
  assert.equal(workspaceFolderName(state.workspaces[0]!, state.tabs, state.panes), '/')
})

test('explicit tab names survive terminal titles and graph restore; clearing restores automatic naming', () => {
  resetStore()
  const first = usePettyStore.getState()
  const tabId = first.activeTabId!
  const paneId = first.activePaneId!
  first.setPaneTitle(paneId, 'nvim')
  first.renameTab(tabId, 'Project')
  usePettyStore.getState().setPaneTitle(paneId, 'git')
  assert.equal(usePettyStore.getState().tabs[0]?.name, 'Project')
  const graph = selectMuxGraphSnapshot(usePettyStore.getState())
  usePettyStore.getState().applyMuxGraph(graph)
  const restored = usePettyStore.getState().tabs[0]!
  assert.equal((restored.extensions as Record<string, unknown>).pettyManualName, 'Project')
  usePettyStore.getState().renameTab(tabId, '')
  const cleared = usePettyStore.getState().tabs[0]!
  assert.equal((cleared.extensions as Record<string, unknown>).pettyManualName, undefined)
})

test('workspaces keep separate tab selections across graph snapshots', () => {
  resetStore()
  const firstWorkspace = usePettyStore.getState().workspaces[0]!
  usePettyStore.getState().newTab()
  const secondTab = usePettyStore.getState().activeTabId
  usePettyStore.getState().newWorkspace()
  const secondWorkspace = usePettyStore.getState().workspaces[1]!
  usePettyStore.getState().newTab()
  const fourthTab = usePettyStore.getState().activeTabId
  usePettyStore.getState().selectWorkspace(firstWorkspace.id)
  assert.equal(usePettyStore.getState().activeTabId, secondTab)
  usePettyStore.getState().selectTabByIndex(0)
  assert.equal(usePettyStore.getState().activeTabId, usePettyStore.getState().tabs[0]?.id)
  usePettyStore.getState().selectWorkspace(secondWorkspace.id)
  assert.equal(usePettyStore.getState().activeTabId, fourthTab)

  const graph = selectMuxGraphSnapshot(usePettyStore.getState())
  graph.extensions = { ...(graph.extensions as object), otherFeature: { enabled: true } }
  graph.tabs[0]!.extensions = { ...(graph.tabs[0]!.extensions as object), otherFeature: 'kept' }
  usePettyStore.getState().applyMuxGraph(graph)
  const restored = selectMuxGraphSnapshot(usePettyStore.getState())
  assert.deepEqual((restored.extensions as Record<string, unknown>).otherFeature, { enabled: true })
  const firstTab = restored.tabs[0]
  assert.ok(firstTab)
  assert.equal((firstTab.extensions as Record<string, unknown>).otherFeature, 'kept')
  usePettyStore.getState().selectWorkspace(firstWorkspace.id)
  assert.equal(usePettyStore.getState().activeTabId, usePettyStore.getState().tabs[0]?.id)
  usePettyStore.getState().closeWorkspace(secondWorkspace.id)
  assert.equal(usePettyStore.getState().tabs.length, 2)
  assert.deepEqual(
    usePettyStore.getState().workspaces.map((workspace) => workspace.id),
    [firstWorkspace.id],
  )
})

test('settings search finds rows and shortcuts across sections', () => {
  assert.equal(searchSettings('font size', undefined)[0]?.targetId, 'font-size')
  assert.equal(
    searchSettings('history', undefined).some((result) => result.targetId === 'save-history'),
    true,
  )
  assert.equal(
    searchSettings('split right', undefined).some((result) => result.section === 'Keyboard'),
    true,
  )
})

test('discards pre-v2 workspace-centric layouts', () => {
  resetStore()
  const legacy = {
    version: 1,
    workspaces: [{ id: 'ws', name: 'Project', projectPath: '/tmp/p', order: 0 }],
    tabs: [],
    panes: [],
    activeTabId: null,
    activePaneId: null,
  } as unknown as PaneLayoutData
  usePettyStore.getState().hydrateLayout(legacy)
  const state = usePettyStore.getState()
  assert.equal(state.tabs.length, 1)
  assert.equal(state.panes[0]?.type, 'terminal')
})

test('mux graph split percentages stay bounded', () => {
  const percentages = normalizeSplitPercentages([1, 99], 2)
  assert.deepEqual(percentages, [5, 95])
  const threeWay = normalizeSplitPercentages([1, 1, 98], 3)
  assert.equal(threeWay.length, 3)
  assert.ok(Math.abs(threeWay.reduce((sum, value) => sum + value, 0) - 100) < 0.01)
  for (const value of threeWay) {
    assert.ok(value >= 5 && value <= 95, `expected ${value} in [5, 95]`)
  }
  assert.deepEqual(
    collectPaneIds({
      type: 'split',
      direction: 'row',
      children: ['a', 'b'],
      splitPercentages: [50, 50],
    }),
    ['a', 'b'],
  )
})

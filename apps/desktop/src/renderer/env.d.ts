/**
 * Type declarations for the renderer process.
 * These types describe the API exposed by the preload script via contextBridge.
 */

import type { AppCommand } from '@petty/shared/app-command'
import type { PettydPtyBridgeDiagnostics } from '../main/pty-protocol'
import type { SettingsData } from '@petty/shared/session'
import type { MuxGraphSnapshot } from '@petty/shared/mux-graph'
import type {
  AttachSessionInput,
  AttachSessionResult,
  CreateSessionInput,
  CreateSessionResult,
  CurrentScreenSnapshotFrame,
  ExitInfo,
  OutputFrame,
  PettydLifecycleDiagnostics,
  PettydLifecycleRecoveryInput,
} from '@petty/shared/pettyd-protocol'

type TerminalPreloadDiagnostics = {
  pendingClientMessages: number
  pendingDataSessions: number
  pendingDataChars: number
  pendingDataDroppedChunksTotal: number
  pendingDataDroppedCharsTotal: number
  pendingDataTruncatedCharsTotal: number
  pendingOutputSessions: number
  pendingOutputChars: number
  pendingOutputDroppedFramesTotal: number
  pendingOutputDroppedCharsTotal: number
  pendingOutputTruncatedCharsTotal: number
  pendingSnapshotSessions: number
  readySessions: number
}

export interface ElectronAPI {
  openExternalUrl(url: string): Promise<void>
  writeClipboardText(text: string): Promise<void>
  createSession(input: CreateSessionInput): Promise<CreateSessionResult>
  attachSession(input: AttachSessionInput): Promise<AttachSessionResult>
  detachSession(sessionId: string): Promise<void>
  writeSessionInput(sessionId: string, data: string, encoding?: 'utf8' | 'binary'): void
  acknowledgeSessionOutput(sessionId: string, seq: number): void
  requestSessionResync(sessionId: string, appliedSeq: number): void
  resizeSession(sessionId: string, cols: number, rows: number): void
  killSession(sessionId: string): Promise<void>
  clearSessionHistory(sessionId: string): Promise<void>
  clearAllSessionHistory(): Promise<void>
  onSessionOutput(sessionId: string, callback: (frame: OutputFrame) => void): () => void
  onSessionSnapshot(
    sessionId: string,
    callback: (frame: CurrentScreenSnapshotFrame) => void,
  ): () => void
  onSessionResize(sessionId: string, callback: (cols: number, rows: number) => void): () => void
  onSessionTitle(sessionId: string, callback: (title: string) => void): () => void
  onSessionProcessTitle(sessionId: string, callback: (title: string) => void): () => void
  onSessionCwd(sessionId: string, callback: (cwd: string) => void): () => void
  onSessionExit(sessionId: string, callback: (info: ExitInfo) => void): () => void
  onSessionError(sessionId: string, callback: (error: string) => void): () => void
  /** @deprecated Prefer createSession/attachSession. Kept for benchmarks. */
  spawnPty(
    sessionId: string,
    cols: number,
    rows: number,
    cwd?: string,
  ): Promise<{ cols: number; rows: number }>
  /** @deprecated Prefer writeSessionInput. Kept for benchmarks. */
  sendPtyInput(sessionId: string, data: string): void
  resizePty(sessionId: string, cols: number, rows: number): void
  killPty(sessionId: string): void
  /** @deprecated Text compatibility; replays unconsumed startup bytes, not binary-stream history. Prefer onSessionOutput. */
  onPtyData(sessionId: string, callback: (data: string) => void): () => void
  onPtyError(sessionId: string, callback: (error: string) => void): () => void
  onPtyExit(
    sessionId: string,
    callback: (info: { exitCode: number; signal?: number }) => void,
  ): () => void
  signalReady(): Promise<void>
  onAppCommand(callback: (command: AppCommand) => void): () => void
  getTerminalPreloadDiagnostics(): TerminalPreloadDiagnostics
  getPettydDiagnostics(): Promise<PettydLifecycleDiagnostics | null>
  getPettydPtyBridgeDiagnostics(): Promise<PettydPtyBridgeDiagnostics | null>
  recoverPettyd(action: PettydLifecycleRecoveryInput): Promise<PettydLifecycleDiagnostics | null>
  getMuxGraph(): Promise<MuxGraphSnapshot>
  replaceMuxGraph(snapshot: MuxGraphSnapshot, expectedRev: number): Promise<MuxGraphSnapshot>
  waitMuxGraph(afterEventSeq: number): Promise<MuxGraphSnapshot>
  captureShortcut(active: boolean): void
  readSettings(): Promise<SettingsData | null>
  writeSettings(data: SettingsData): Promise<void>
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}

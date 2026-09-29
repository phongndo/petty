import { Schema } from 'effect'

const NonEmptyString = Schema.Trim.check(Schema.isNonEmpty())

export const PETTYD_STREAM_MAGIC = 0x50545346 // PTSF
export const PETTYD_STREAM_VERSION = 1
export const PETTYD_STREAM_SESSION_ID_SIZE = 64
export const PETTYD_STREAM_HEADER_SIZE = 88
export const PETTYD_STREAM_MAX_PAYLOAD_BYTES = 64 * 1024 * 1024

export const PETTYD_CONTROL_PROTOCOL_VERSION = 2
export const PETTYD_CONTROL_CAPABILITIES = [
  'sessions-v1',
  'stream-frames-v1',
  'persistence-v1',
  'mux-graph-v2',
] as const

export const PettydStreamFrameKind = {
  Output: 1,
  Input: 2,
  Resize: 3,
  Snapshot: 4,
  Exit: 5,
} as const

export type PettydStreamFrameKind =
  (typeof PettydStreamFrameKind)[keyof typeof PettydStreamFrameKind]
export type PettydControlCapability = (typeof PETTYD_CONTROL_CAPABILITIES)[number]

export const PettydLifecycleStateSchema = Schema.Union([
  Schema.Literal('absent'),
  Schema.Literal('starting'),
  Schema.Literal('owned-live'),
  Schema.Literal('external-live'),
  Schema.Literal('stale-socket'),
  Schema.Literal('crashed'),
  Schema.Literal('version-mismatch'),
  Schema.Literal('stopping'),
  Schema.Literal('disposed'),
])

export const PettydDaemonOwnershipSchema = Schema.Union([
  Schema.Literal('none'),
  Schema.Literal('external'),
  Schema.Literal('owned-attached'),
  Schema.Literal('owned-detached'),
  Schema.Literal('released-detached'),
])

export const PettydLifecycleRecoveryActionSchema = Schema.Union([
  Schema.Literal('none'),
  Schema.Literal('start-daemon'),
  Schema.Literal('wait-for-start'),
  Schema.Literal('reuse-external-daemon'),
  Schema.Literal('keep-detached-daemon'),
  Schema.Literal('clear-stale-socket-and-start'),
  Schema.Literal('restart-owned-daemon'),
  Schema.Literal('replace-incompatible-daemon'),
])

export const PettydLifecycleRecoveryInputSchema = PettydLifecycleRecoveryActionSchema

export const PettydLifecycleEventSchema = Schema.Struct({
  state: PettydLifecycleStateSchema,
  at: Schema.Number,
  reason: Schema.optional(Schema.String),
})

export const PettydControlRequestDiagnosticsSchema = Schema.Struct({
  id: Schema.String,
  traceId: Schema.String,
  responseTraceId: Schema.optional(Schema.String),
  type: Schema.String,
  at: Schema.Number,
  durationMs: Schema.Number,
  ok: Schema.Boolean,
  error: Schema.optional(Schema.String),
})

export const PettydStreamDiagnosticsSchema = Schema.Struct({
  activeSubscribers: Schema.Number,
  pendingOutputSessions: Schema.Number,
  pendingOutputFrames: Schema.Number,
  pendingOutputBytes: Schema.Number,
  inputFramesTotal: Schema.Number,
  inputBytesTotal: Schema.Number,
  outputFramesTotal: Schema.Number,
  outputBytesTotal: Schema.Number,
  lastPtyReadNs: Schema.optional(Schema.Number),
  slowSubscriberDropsTotal: Schema.Number,
  pendingOutputDroppedFramesTotal: Schema.Number,
  pendingOutputDroppedBytesTotal: Schema.Number,
  pendingOutputTruncatedBytesTotal: Schema.Number,
  /** Latest output seq acknowledged by the renderer (Phase 2.5). */
  acknowledgedSeq: Schema.optional(Schema.Number),
  /** Age of oldest unreacked queued frame in ms. */
  oldestPendingAgeMs: Schema.optional(Schema.Number),
})

export const PettydDaemonControlDiagnosticsSchema = Schema.Struct({
  requestCount: Schema.Number,
  failureCount: Schema.Number,
  lastRequestType: Schema.optional(Schema.String),
  lastTraceId: Schema.optional(Schema.String),
  lastDurationMs: Schema.optional(Schema.Number),
  lastOk: Schema.optional(Schema.Boolean),
  lastRecordedAtMs: Schema.optional(Schema.Number),
})

export const PettydLifecycleTimingDiagnosticsSchema = Schema.Struct({
  clientCreatedAt: Schema.Number,
  lastTransitionAt: Schema.Number,
  lastPingStartedAt: Schema.optional(Schema.Number),
  lastPingDurationMs: Schema.optional(Schema.Number),
  lastSuccessfulPingAt: Schema.optional(Schema.Number),
  lastFailedPingAt: Schema.optional(Schema.Number),
  lastStartRequestedAt: Schema.optional(Schema.Number),
  lastStartDurationMs: Schema.optional(Schema.Number),
})

export const PettydLifecycleDiagnosticsSchema = Schema.Struct({
  clientTraceId: Schema.String,
  state: PettydLifecycleStateSchema,
  socketPath: Schema.String,
  detachDaemon: Schema.Boolean,
  healthChecksEnabled: Schema.Boolean,
  healthChecksStarted: Schema.Boolean,
  startInFlight: Schema.Boolean,
  restartScheduled: Schema.Boolean,
  daemonOwnership: PettydDaemonOwnershipSchema,
  recoveryAction: PettydLifecycleRecoveryActionSchema,
  spawnedPid: Schema.optional(Schema.Number),
  releasedDetachedPid: Schema.optional(Schema.Number),
  daemonVersion: Schema.optional(Schema.String),
  protocolVersion: Schema.optional(Schema.Number),
  capabilities: Schema.Array(Schema.String),
  lastReason: Schema.optional(Schema.String),
  lastError: Schema.optional(Schema.String),
  controlRequestCount: Schema.Number,
  controlRequestFailureCount: Schema.Number,
  lastControlRequest: Schema.optional(PettydControlRequestDiagnosticsSchema),
  streamDiagnostics: Schema.optional(PettydStreamDiagnosticsSchema),
  daemonControlDiagnostics: Schema.optional(PettydDaemonControlDiagnosticsSchema),
  timing: PettydLifecycleTimingDiagnosticsSchema,
  transitions: Schema.Array(PettydLifecycleEventSchema),
})

export const PettydStreamFrameKindSchema = Schema.Union([
  Schema.Literal(PettydStreamFrameKind.Output),
  Schema.Literal(PettydStreamFrameKind.Input),
  Schema.Literal(PettydStreamFrameKind.Resize),
  Schema.Literal(PettydStreamFrameKind.Snapshot),
  Schema.Literal(PettydStreamFrameKind.Exit),
])

export const AttachSessionModeSchema = Schema.Union([
  Schema.Literal('live'),
  Schema.Literal('fresh'),
  Schema.Literal('command-resume'),
])

export const CreateSessionInputSchema = Schema.Struct({
  terminalId: NonEmptyString,
  cols: Schema.Number,
  rows: Schema.Number,
  cwd: Schema.optional(Schema.String),
  argv: Schema.optional(Schema.Array(Schema.String)),
})

export const CreateSessionResultSchema = Schema.Struct({
  sessionId: NonEmptyString,
  pid: Schema.optional(Schema.Number),
})

export const AttachSessionInputSchema = Schema.Struct({
  sessionId: Schema.optional(NonEmptyString),
  terminalId: Schema.optional(NonEmptyString),
  cols: Schema.optional(Schema.Number),
  rows: Schema.optional(Schema.Number),
  cwd: Schema.optional(Schema.String),
  argv: Schema.optional(Schema.Array(Schema.String)),
})

export const AttachSessionResultSchema = Schema.Struct({
  sessionId: NonEmptyString,
  seq: Schema.Number,
  cwd: Schema.optional(Schema.String),
  cols: Schema.Number,
  rows: Schema.Number,
  archived: Schema.optional(Schema.Boolean),
  attachMode: Schema.optional(AttachSessionModeSchema),
})

export const OutputFrameSchema = Schema.Struct({
  sessionId: NonEmptyString,
  seq: Schema.Number,
  data: Schema.Uint8Array,
})

export const CurrentScreenSnapshotFrameSchema = Schema.Struct({
  sessionId: NonEmptyString,
  seq: Schema.Number,
  data: Schema.Uint8Array,
  live: Schema.optional(Schema.Boolean),
})

export const ExitInfoSchema = Schema.Struct({
  exitCode: Schema.Number,
  signal: Schema.optional(Schema.Number),
})

export type CreateSessionInput = Schema.Schema.Type<typeof CreateSessionInputSchema>
export type CreateSessionResult = Schema.Schema.Type<typeof CreateSessionResultSchema>
export type AttachSessionMode = Schema.Schema.Type<typeof AttachSessionModeSchema>
export type AttachSessionInput = Schema.Schema.Type<typeof AttachSessionInputSchema>
export type AttachSessionResult = Schema.Schema.Type<typeof AttachSessionResultSchema>
export type OutputFrame = Schema.Schema.Type<typeof OutputFrameSchema>
export type CurrentScreenSnapshotFrame = Schema.Schema.Type<typeof CurrentScreenSnapshotFrameSchema>
export type ExitInfo = Schema.Schema.Type<typeof ExitInfoSchema>
export type PettydLifecycleState = Schema.Schema.Type<typeof PettydLifecycleStateSchema>
export type PettydDaemonOwnership = Schema.Schema.Type<typeof PettydDaemonOwnershipSchema>
export type PettydLifecycleRecoveryAction = Schema.Schema.Type<
  typeof PettydLifecycleRecoveryActionSchema
>
export type PettydLifecycleRecoveryInput = Schema.Schema.Type<
  typeof PettydLifecycleRecoveryInputSchema
>
export type PettydLifecycleEvent = Schema.Schema.Type<typeof PettydLifecycleEventSchema>
export type PettydControlRequestDiagnostics = Schema.Schema.Type<
  typeof PettydControlRequestDiagnosticsSchema
>
export type PettydStreamDiagnostics = Schema.Schema.Type<typeof PettydStreamDiagnosticsSchema>
export type PettydDaemonControlDiagnostics = Schema.Schema.Type<
  typeof PettydDaemonControlDiagnosticsSchema
>
export type PettydLifecycleTimingDiagnostics = Schema.Schema.Type<
  typeof PettydLifecycleTimingDiagnosticsSchema
>
export type PettydLifecycleDiagnostics = Schema.Schema.Type<typeof PettydLifecycleDiagnosticsSchema>

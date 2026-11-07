export { createUncageClient, uploadContentType } from './client.js';
export type {
  ConnectionState,
  CreateSessionRequest,
  InstallInfo,
  SubscribeHandlers,
  UncageClient,
  UncageClientOptions,
} from './client.js';
export { ERROR_REASONS, UncageClientError } from './errors.js';
export { parseSSE } from './sse.js';
export type { SSEFrame } from './sse.js';
export { isErrorBody, isUncageEvent } from './guards.js';
// The protocol types this API speaks, so apps need no direct `@uncage/protocol` dependency.
export type {
  ActiveRunInfo,
  ApprovalCategory,
  ApprovalDecision,
  ApprovalRequest,
  ApprovalState,
  ApprovalTarget,
  Attachment,
  CreateSessionBody,
  EffortLevel,
  ErrorBody,
  ErrorCode,
  EventEnvelope,
  EventType,
  HealthResponse,
  MachineInfo,
  ModelOption,
  PermissionMode,
  Run,
  RunState,
  RuntimeCapabilities,
  RuntimeInfo,
  RuntimeStatus,
  Session,
  SessionSettings,
  SessionSnapshot,
  StartRunBody,
  ToolInfo,
  UncageEvent,
  UncageEventMap,
  UpdateSessionSettingsBody,
} from '@uncage/protocol';

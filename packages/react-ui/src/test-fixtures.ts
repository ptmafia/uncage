import { UncageClientError, type SubscribeHandlers, type UncageClient } from '@uncage/client';
import type {
  ActiveRunInfo,
  ApprovalRequest,
  Attachment,
  RuntimeCapabilities,
  ErrorCode,
  EventType,
  MachineInfo,
  Run,
  RuntimeInfo,
  Session,
  SessionSettings,
  SessionSnapshot,
  UncageEvent,
  UncageEventMap,
} from '@uncage/protocol';
import { ATTACHMENT_LIMITS } from '@uncage/protocol';
import { vi } from 'vitest';

export const T0 = new Date(Date.now() - 5_000).toISOString();
const IN_10_MIN = new Date(Date.now() + 600_000).toISOString();

const capabilities = {
  streaming: true,
  approval: { once: true, session: false, types: ['shell' as const, 'file' as const] },
  nativeResume: true,
  diffEvents: false,
  mcp: false,
  skills: 'unknown' as const,
  siteTools: false,
  models: [],
  efforts: [],
  permissionModes: ['default' as const],
  attachments: { images: false, files: false, maxBytes: ATTACHMENT_LIMITS.maxBytes },
};

/** Capabilities with every composer control populated (bypass only when `bypass`). */
export const richCaps = (bypass = false): RuntimeCapabilities => ({
  ...capabilities,
  models: [
    { id: 'default', label: 'Default', description: 'The runtime default' },
    { id: 'opus', label: 'Opus', description: 'Most capable' },
    { id: 'sonnet', label: 'Sonnet' },
  ],
  modelsAuthoritative: true,
  efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  permissionModes: ['default', 'acceptEdits', 'plan', 'auto', ...(bypass ? (['bypassPermissions'] as const) : [])],
  attachments: { images: true, files: true, maxBytes: ATTACHMENT_LIMITS.maxBytes },
});

export const attachment = (over: Partial<Attachment> = {}): Attachment => ({
  id: 'att_1',
  sessionId: 'ses_1',
  name: 'shot.png',
  mime: 'image/png',
  size: 2048,
  kind: 'image',
  sha256: 'x',
  createdAt: T0,
  ...over,
});

export const session = (over: Partial<Session> = {}): Session => ({
  id: 'ses_1',
  runtimeId: 'claude',
  workspace: '/w',
  title: 'Fix the build',
  status: 'ready',
  readOnly: false,
  createdAt: T0,
  capabilities,
  settings: { permissionMode: 'default' },
  ...over,
});

export const runtime = (over: Partial<RuntimeInfo> = {}): RuntimeInfo => ({
  id: 'claude',
  displayName: 'Claude Code',
  status: 'available',
  version: '2.1.0',
  capabilities,
  ...over,
});

export const run = (over: Partial<Run> = {}): Run => ({
  id: 'run_1',
  sessionId: 'ses_1',
  prompt: 'hello',
  state: 'queued',
  createdAt: T0,
  ...over,
});

export const approval = (over: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
  id: 'apr_1',
  sessionId: 'ses_1',
  runId: 'run_1',
  toolId: 'tool_1',
  runtimeId: 'claude',
  category: 'shell',
  title: 'Bash',
  description: 'Remove the build folder',
  target: { command: 'rm -rf build', cwd: '/w' },
  allowedScopes: ['once'],
  availableDecisions: ['allow_once', 'deny'],
  state: 'pending',
  createdAt: T0,
  expiresAt: IN_10_MIN,
  version: 1,
  ...over,
});

export const snapshot = (over: Partial<SessionSnapshot> = {}): SessionSnapshot => ({
  session: session(),
  runs: [],
  pendingApprovals: [],
  lastSequence: 0,
  ...over,
});

export const machine = (over: Partial<MachineInfo> = {}): MachineInfo => ({
  id: 'mac_1',
  name: 'MacBook Pro',
  os: 'darwin',
  agentVersion: '0.2.0',
  runtimes: [runtime()],
  online: true,
  lastSeenAt: T0,
  ...over,
});

export const INSTALL = {
  install: 'curl -fsSL https://site.test/api/uncage/install.sh | bash',
  setup: 'uncage setup https://site.test/api/uncage',
  windows: null,
};

export const clientError = (code: ErrorCode, status: number, message: string = code, hint?: string) =>
  new UncageClientError({ code, message, retryable: false, ...(hint ? { hint } : {}) }, status);

/** Builds events with auto-incrementing sequences. */
export function eventFactory(start = 1) {
  let seq = start;
  return <K extends EventType>(type: K, payload: UncageEventMap[K], runId = 'run_1'): UncageEvent =>
    ({
      eventId: `evt_${seq}`,
      sequence: seq++,
      sessionId: 'ses_1',
      runId,
      type,
      occurredAt: new Date().toISOString(),
      schemaVersion: '1.0',
      payload,
    }) as UncageEvent;
}

/**
 * An in-memory UncageClient driving the real store. `emit` pushes events to the live subscription.
 * A local daemon by default (`machines()` → 404); `machines` makes it a connected-mode hub (a
 * function is read on every poll).
 */
export function fakeClient(
  opts: {
    runtimes?: RuntimeInfo[];
    sessions?: Session[];
    snapshot?: () => SessionSnapshot;
    machines?: MachineInfo[] | (() => MachineInfo[]);
  } = {},
) {
  const subs: (SubscribeHandlers & { sessionId: string; closed: boolean })[] = [];
  let runCount = 0;
  let uploadCount = 0;
  const snap = opts.snapshot ?? (() => snapshot());
  const client = {
    health: vi.fn(async () => ({ ok: true as const, protocol: '1.0' as const })),
    runtimes: vi.fn(async () => opts.runtimes ?? [runtime()]),
    createSession: vi.fn(async (b: { runtime: string }) => session({ id: 'ses_new', runtimeId: b.runtime, title: 'New' })),
    listSessions: vi.fn(async () => opts.sessions ?? [session()]),
    snapshot: vi.fn(async (id: string) => {
      const s = snap();
      return id === s.session.id ? s : { ...s, session: { ...s.session, id } };
    }),
    startRun: vi.fn(async (sessionId: string, b: { prompt: string }) =>
      run({ id: `run_${++runCount}`, sessionId, prompt: b.prompt }),
    ),
    cancelRun: vi.fn(async (id: string) => run({ id, state: 'cancelled' })),
    updateSettings: vi.fn(async (id: string, patch: Partial<SessionSettings>) =>
      session({ id, settings: { permissionMode: 'default', ...patch } }),
    ),
    uploadAttachment: vi.fn(async (sessionId: string, file: Blob & { name: string }) =>
      attachment({ id: `att_${++uploadCount}`, sessionId, name: file.name, size: file.size, mime: file.type }),
    ),
    attachmentUrl: vi.fn((id: string) => `/api/uncage/attachments/${id}`),
    listActiveRuns: vi.fn(async (): Promise<ActiveRunInfo[]> => []),
    decide: vi.fn(async (id: string) => approval({ id, state: 'approved', decision: 'allow', version: 2 })),
    machines: vi.fn(async (): Promise<MachineInfo[]> => {
      const m = opts.machines;
      if (m === undefined) throw clientError('not_found', 404, 'No route for GET /v1/machines.');
      return typeof m === 'function' ? m() : m;
    }),
    installInfo: vi.fn(async (): Promise<{ install: string; setup: string; windows: string | null }> => INSTALL),
    revokeMachine: vi.fn(async (): Promise<void> => undefined),
    subscribe: vi.fn((sessionId: string, h: SubscribeHandlers) => {
      const sub = { ...h, sessionId, closed: false };
      subs.push(sub);
      return () => {
        sub.closed = true;
      };
    }),
  } satisfies UncageClient;
  const live = () => subs.filter((s) => !s.closed).at(-1);
  return {
    client,
    emit: (e: UncageEvent) => live()?.onEvent(e),
    live: () => live()?.onState?.('live'),
  };
}

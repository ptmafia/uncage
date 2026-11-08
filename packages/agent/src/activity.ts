import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { redactForExport } from '@uncage/core';
import { activityLogPath } from './config.js';

export type ActivityKind =
  | 'connected'
  | 'disconnected'
  | 'revoked'
  | 'replaced'
  | 'upgrade'
  | 'command'
  | 'tool_call'
  | 'file_pull'
  | 'approval';

/** One JSONL line of `~/.uncage/sites/<siteId>/activity.log`. `detail` is always redacted. */
export interface ActivityEntry {
  at: string;
  site: string;
  kind: ActivityKind;
  /** Command op, tool name, … */
  name?: string;
  ok?: boolean;
  /** Error code on failure. */
  code?: string;
  detail?: unknown;
}

/**
 * Append-only local record of everything a website asked this machine to do. Content is redacted
 * with the same allowlist as `uncage doctor --export-events` (ids, states and codes stay readable;
 * prompts, file contents and tool args become length placeholders). Writes are serialized.
 */
export class ActivityLog {
  private queue: Promise<void> = Promise.resolve();
  private ready: Promise<void> | undefined;
  readonly path: string;

  constructor(
    home: string,
    private readonly siteId: string,
    private readonly onError: (err: unknown) => void = () => undefined,
  ) {
    this.path = activityLogPath(home, siteId);
  }

  append(e: Omit<ActivityEntry, 'at' | 'site'>): Promise<void> {
    const entry: ActivityEntry = {
      at: new Date().toISOString(),
      site: this.siteId,
      ...e,
      ...(e.detail !== undefined ? { detail: redactForExport(e.detail) } : {}),
    };
    const line = `${JSON.stringify(entry)}\n`;
    this.ready ??= mkdir(dirname(this.path), { recursive: true, mode: 0o700 }).then(() => undefined);
    this.queue = this.queue
      .then(() => this.ready)
      .then(() => appendFile(this.path, line, { mode: 0o600 }))
      .catch(this.onError);
    return this.queue;
  }

  /** Resolves once every append so far is on disk. */
  flush(): Promise<void> {
    return this.queue;
  }
}

/** Parses an activity log; unreadable lines are skipped. Missing file → []. */
export async function readActivity(home: string, siteId: string): Promise<ActivityEntry[]> {
  let raw: string;
  try {
    raw = await readFile(activityLogPath(home, siteId), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  return parseActivityLines(raw);
}

export function parseActivityLines(raw: string): ActivityEntry[] {
  const out: ActivityEntry[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as ActivityEntry);
    } catch {
      // partial line (being written) or corruption: skip
    }
  }
  return out;
}

export function formatActivity(e: ActivityEntry): string {
  const status = e.ok === undefined ? '' : e.ok ? ' ok' : ` failed${e.code ? ` (${e.code})` : ''}`;
  const detail = e.detail === undefined ? '' : ` ${JSON.stringify(e.detail)}`;
  return `${e.at}  ${e.site}  ${e.kind}${e.name ? ` ${e.name}` : ''}${status}${detail}`;
}

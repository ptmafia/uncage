import { open, stat } from 'node:fs/promises';
import { activityLogPath, formatActivity, loadAgentConfig, parseActivityLines, readActivity, type ActivityEntry } from '@uncage/agent';

export const ACTIVITY_HELP = `uncage activity - what connected websites asked this computer to do

Usage:
  uncage activity [--site <id>] [--follow] [--json]

Every command, site tool call, file pull and approval is recorded (redacted: ids, states and
error codes are kept; prompts, file contents and tool arguments are not) in
~/.uncage/sites/<id>/activity.log.

Options:
  --site <id>   Only this website (see: uncage sites).
  --follow      Keep printing new entries.
  --json        One JSON object per line.
  -h, --help    Show this help.`;

async function siteIds(home: string, site?: string): Promise<string[]> {
  const ids = (await loadAgentConfig(home)).sites.map((s) => s.id);
  if (site) {
    if (!ids.includes(site)) throw new Error(`No connected website "${site}". See: uncage sites`);
    return [site];
  }
  return ids;
}

export async function showActivity(o: {
  home: string;
  site?: string;
  json?: boolean;
  follow?: boolean;
  out: (l: string) => void;
  signal?: AbortSignal;
  pollMs?: number;
}): Promise<void> {
  const fmt = (e: ActivityEntry) => (o.json ? JSON.stringify(e) : formatActivity(e));
  const ids = await siteIds(o.home, o.site);
  const all = (await Promise.all(ids.map((id) => readActivity(o.home, id)))).flat().sort((a, b) => a.at.localeCompare(b.at));
  if (all.length === 0 && !o.follow) o.out('No activity yet.');
  for (const e of all) o.out(fmt(e));
  if (!o.follow) return;

  // Tail: remember each file's size, print what is appended.
  const offsets = new Map<string, number>();
  for (const id of ids) offsets.set(id, await stat(activityLogPath(o.home, id)).then((s) => s.size, () => 0));
  const pending = new Map<string, string>();
  while (!o.signal?.aborted) {
    await new Promise((r) => setTimeout(r, o.pollMs ?? 500));
    for (const id of ids) {
      const path = activityLogPath(o.home, id);
      const size = await stat(path).then((s) => s.size, () => 0);
      const from = offsets.get(id) ?? 0;
      if (size <= from) {
        if (size < from) offsets.set(id, size); // truncated
        continue;
      }
      const fh = await open(path, 'r');
      try {
        const buf = Buffer.alloc(size - from);
        await fh.read(buf, 0, buf.length, from);
        offsets.set(id, size);
        const text = (pending.get(id) ?? '') + buf.toString('utf8');
        const cut = text.lastIndexOf('\n');
        pending.set(id, text.slice(cut + 1));
        for (const e of parseActivityLines(text.slice(0, cut + 1))) o.out(fmt(e));
      } finally {
        await fh.close();
      }
    }
  }
}

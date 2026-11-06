import { describe, expect, it } from 'vitest';
import {
  RuntimeCapabilitiesSchema,
  RuntimeProbeSchema,
  type AdapterRunContext,
  type ApprovalOutcome,
  type NativeApprovalInput,
  type RuntimeAdapter,
  type RuntimeEvent,
} from '@uncage/protocol';

export async function collect(it: AsyncIterable<RuntimeEvent>): Promise<RuntimeEvent[]> {
  const out: RuntimeEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

const TERMINAL = new Set(['run.completed', 'run.failed', 'run.interrupted']);
const CATEGORIES = ['shell', 'file', 'network', 'mcp', 'other'];

function makeCtx(decide: (i: NativeApprovalInput) => Promise<ApprovalOutcome>, signal = new AbortController().signal) {
  const requests: NativeApprovalInput[] = [];
  const ctx: AdapterRunContext = {
    signal,
    requestApproval: (input) => {
      requests.push(input);
      return decide(input);
    },
  };
  return { ctx, requests };
}

const input = (prompt: string) => ({ runId: 'run_contract', prompt, cwd: process.cwd() });

export function runAdapterContract(
  name: string,
  make: () => RuntimeAdapter | Promise<RuntimeAdapter>,
  scenarios: { simple: string; approval: string; crash?: string },
): void {
  describe(`adapter contract: ${name}`, () => {
    it('1. simple run has one terminal event (run.completed), well-formed messages', async () => {
      const adapter = await make();
      const { ctx } = makeCtx(() => Promise.resolve({ decision: 'allow' }));
      const events = await collect(adapter.run(input(scenarios.simple), ctx));
      const terminals = events.filter((e) => TERMINAL.has(e.type));
      expect(terminals).toHaveLength(1);
      expect(events.at(-1)?.type).toBe('run.completed');
      const started = new Set<string>();
      const deltas = new Map<string, string>();
      for (const e of events) {
        if (e.type === 'message.started') started.add(e.messageId);
        if (e.type === 'message.delta') {
          expect(started.has(e.messageId)).toBe(true);
          deltas.set(e.messageId, (deltas.get(e.messageId) ?? '') + e.text);
        }
        if (e.type === 'message.completed' && deltas.has(e.messageId)) {
          expect(deltas.get(e.messageId)).toBe(e.text);
        }
      }
      const completed = new Set(
        events.flatMap((e) => (e.type === 'message.completed' ? [e.messageId] : [])),
      );
      for (const id of deltas.keys()) expect(completed.has(id), `message.completed for ${id}`).toBe(true);
      await adapter.dispose?.();
    });

    it('2. approval + allow: requestApproval once, tool.completed, then run.completed', async () => {
      const adapter = await make();
      const { ctx, requests } = makeCtx(() => Promise.resolve({ decision: 'allow' }));
      const events = await collect(adapter.run(input(scenarios.approval), ctx));
      expect(requests).toHaveLength(1);
      expect(CATEGORIES).toContain(requests[0]?.category);
      const types = events.map((e) => e.type);
      expect(types.indexOf('tool.completed')).toBeGreaterThanOrEqual(0);
      expect(types.indexOf('tool.completed')).toBeLessThan(types.indexOf('run.completed'));
      expect(types.at(-1)).toBe('run.completed');
      await adapter.dispose?.();
    });

    it('3. approval + deny: tool.failed declined, run still completes', async () => {
      const adapter = await make();
      const { ctx } = makeCtx(() => Promise.resolve({ decision: 'deny' }));
      const events = await collect(adapter.run(input(scenarios.approval), ctx));
      expect(events.some((e) => e.type === 'tool.failed' && e.declined === true)).toBe(true);
      expect(events.at(-1)?.type).toBe('run.completed');
      await adapter.dispose?.();
    });

    it('4. abort mid-run ends within 5s with at most one run.interrupted afterwards', async () => {
      const adapter = await make();
      const controller = new AbortController();
      let asked!: () => void;
      const approvalPending = new Promise<void>((r) => (asked = r));
      // Approval never resolves: abort must unblock the adapter anyway.
      const { ctx, requests } = makeCtx(() => {
        asked();
        return new Promise<ApprovalOutcome>(() => undefined);
      }, controller.signal);
      const iterator = adapter.run(input(scenarios.approval), ctx)[Symbol.asyncIterator]();
      const before: RuntimeEvent[] = [];
      const after: RuntimeEvent[] = [];
      let aborted = false;
      const drain = (async () => {
        for (;;) {
          const r = await iterator.next();
          if (r.done) return;
          (aborted ? after : before).push(r.value);
        }
      })();
      await Promise.race([approvalPending, drain]);
      // The abort must hit while an approval is pending, not after the run ended on its own.
      expect(requests).toHaveLength(1);
      // Let events emitted before the approval request flush.
      await new Promise((r) => setTimeout(r, 20));
      aborted = true;
      controller.abort();
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<'timeout'>((r) => (timer = setTimeout(() => r('timeout'), 5000)));
      const result = await Promise.race([drain.then(() => 'done' as const), timeout]);
      clearTimeout(timer);
      expect(result).toBe('done');
      expect(after.length).toBeLessThanOrEqual(1);
      if (after[0]) expect(after[0].type).toBe('run.interrupted');
      await adapter.dispose?.();
    }, 10_000);

    if (scenarios.crash !== undefined) {
      const crashPrompt = scenarios.crash;
      it('5. crash ends with run.interrupted or run.failed(runtime_disconnected)', async () => {
        const adapter = await make();
        const { ctx } = makeCtx(() => Promise.resolve({ decision: 'allow' }));
        const events = await collect(adapter.run(input(crashPrompt), ctx));
        const last = events.at(-1);
        const ok =
          last?.type === 'run.interrupted' ||
          (last?.type === 'run.failed' && last.error.code === 'runtime_disconnected');
        expect(ok).toBe(true);
        await adapter.dispose?.();
      });
    }

    it('6. capabilities() and probe() are valid', async () => {
      const adapter = await make();
      expect(RuntimeCapabilitiesSchema.safeParse(adapter.capabilities()).success).toBe(true);
      expect(RuntimeProbeSchema.safeParse(await adapter.probe()).success).toBe(true);
      await adapter.dispose?.();
    });
  });
}

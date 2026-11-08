import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
  ApprovalDecision,
  ApprovalRequest,
  ErrorBody,
  ErrorCode,
  Run,
  RuntimeInfo,
  Session,
  SessionSnapshot,
  SubscribeHandlers,
  UncageEvent,
  UncageEventMap,
} from './index.js';

const MAX_MIN_BYTES = 25 * 1024;

describe('@uncage/client bundle (F6)', () => {
  it(`a browser bundle of the whole client stays under ${MAX_MIN_BYTES / 1024} KB minified, with no zod`, async () => {
    const result = await build({
      entryPoints: [fileURLToPath(new URL('./index.ts', import.meta.url))],
      bundle: true,
      minify: true,
      format: 'esm',
      platform: 'browser',
      target: 'es2022',
      write: false,
      metafile: true,
      logLevel: 'silent',
    });
    const [out] = Object.values(result.metafile.outputs);
    const inputs = Object.keys(result.metafile.inputs);
    expect(inputs.filter((i) => /node_modules\/(\.pnpm\/)?zod/.test(i))).toEqual([]);
    expect(inputs.filter((i) => i.includes('protocol/'))).toEqual([]);
    expect(out!.bytes).toBeLessThanOrEqual(MAX_MIN_BYTES);
  });

  it('re-exports the protocol types its API uses (no phantom @uncage/protocol import needed)', () => {
    expectTypeOf<Parameters<SubscribeHandlers['onEvent']>[0]>().toEqualTypeOf<UncageEvent>();
    expectTypeOf<Extract<UncageEvent, { type: 'approval.requested' }>['payload']>().toEqualTypeOf<
      UncageEventMap['approval.requested']
    >();
    expectTypeOf<ApprovalDecision>().toMatchTypeOf<{ decision: 'allow' | 'deny'; scope: 'once' | 'session' }>();
    expectTypeOf<ApprovalRequest['id']>().toBeString();
    expectTypeOf<RuntimeInfo['id']>().toBeString();
    expectTypeOf<Session['id']>().toBeString();
    expectTypeOf<Run['state']>().toBeString();
    expectTypeOf<SessionSnapshot['lastSequence']>().toBeNumber();
    expectTypeOf<ErrorBody['code']>().toEqualTypeOf<ErrorCode>();
  });
});

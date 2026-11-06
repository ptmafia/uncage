import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFakeAdapter, type FakeStep } from '@uncage/testkit';
import type { RuntimeAdapter, RuntimeCapabilities } from '@uncage/protocol';
import { createUncage, type Uncage, type UncageOptions } from './uncage.js';
import { eventsUntil, isTerminal } from './test-utils.js';

const RICH: Partial<RuntimeCapabilities> = {
  models: [
    { id: 'default', label: 'Default' },
    { id: 'opus', label: 'Opus' },
  ],
  efforts: ['low', 'medium', 'high'],
  permissionModes: ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'],
};

describe('session settings', () => {
  const open: Uncage[] = [];
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uncage-settings-'));
  });
  afterEach(async () => {
    for (const u of open.splice(0)) await u.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function make(adapters: RuntimeAdapter[], extra: Partial<UncageOptions> = {}) {
    const u = await createUncage({
      adapters,
      dataDir: 'memory://',
      workspace: { allowedRoots: [dir], default: dir },
      ...extra,
    });
    open.push(u);
    return u;
  }
  const fake = (script: FakeStep[] = [{ text: 'ok' }], caps: Partial<RuntimeCapabilities> = RICH) =>
    createFakeAdapter({ script, capabilities: caps });

  it('new sessions default to permissionMode default', async () => {
    const u = await make([fake()]);
    const s = await u.sessions.create({ runtime: 'fake' });
    expect((await s.get()).settings).toEqual({ permissionMode: 'default' });
  });

  it('updateSettings persists and emits session.updated', async () => {
    const dataDir = join(dir, 'data');
    const u1 = await createUncage({ adapters: [fake()], dataDir, workspace: { allowedRoots: [dir], default: dir } });
    const s = await u1.sessions.create({ runtime: 'fake' });
    const updated = await u1.sessions.updateSettings(s.id, { model: 'opus', effort: 'high', permissionMode: 'plan' });
    expect(updated.settings).toEqual({ model: 'opus', effort: 'high', permissionMode: 'plan' });
    const events = await eventsUntil(s, (e) => e.type === 'session.updated');
    const last = events.at(-1);
    expect(last?.type === 'session.updated' && last.payload.session.settings).toEqual({
      model: 'opus',
      effort: 'high',
      permissionMode: 'plan',
    });
    // Partial patch merges.
    const again = await u1.sessions.updateSettings(s.id, { effort: 'low' });
    expect(again.settings).toEqual({ model: 'opus', effort: 'low', permissionMode: 'plan' });
    await u1.close();

    const u2 = await make([fake()], { dataDir });
    expect((await (await u2.sessions.get(s.id)).get()).settings).toEqual({
      model: 'opus',
      effort: 'low',
      permissionMode: 'plan',
    });
  });

  it('bypass rejected with policy_denied when allowBypass false, accepted when true', async () => {
    const u = await make([fake()]);
    const s = await u.sessions.create({ runtime: 'fake' });
    // Not advertised when the policy forbids it.
    expect((await s.get()).capabilities.permissionModes).not.toContain('bypassPermissions');
    expect((await u.runtimes.get('fake')).capabilities?.permissionModes).not.toContain('bypassPermissions');
    await expect(u.sessions.updateSettings(s.id, { permissionMode: 'bypassPermissions' })).rejects.toMatchObject({
      code: 'policy_denied',
    });
    expect((await s.get()).settings.permissionMode).toBe('default');

    const u2 = await make([fake()], { security: { allowBypass: true } });
    const s2 = await u2.sessions.create({ runtime: 'fake' });
    expect((await s2.get()).capabilities.permissionModes).toContain('bypassPermissions');
    const ok = await u2.sessions.updateSettings(s2.id, { permissionMode: 'bypassPermissions' });
    expect(ok.settings.permissionMode).toBe('bypassPermissions');
  });

  it('restart without allowBypass leaves bypass mode and stops advertising it', async () => {
    const dataDir = join(dir, 'data');
    const opts = { dataDir, workspace: { allowedRoots: [dir], default: dir } };
    const u1 = await createUncage({ adapters: [fake()], ...opts, security: { allowBypass: true } });
    const s = await u1.sessions.create({ runtime: 'fake' });
    await u1.sessions.updateSettings(s.id, { permissionMode: 'bypassPermissions', effort: 'high' });
    await u1.close();

    const adapter = fake();
    const u2 = await make([adapter], { dataDir });
    const s2 = await u2.sessions.get(s.id);
    const after = await s2.get();
    expect(after.settings).toEqual({ permissionMode: 'default', effort: 'high' });
    expect(after.capabilities.permissionModes).not.toContain('bypassPermissions');
    await s2.startRun({ prompt: 'p' });
    await eventsUntil(s2, isTerminal);
    expect(adapter.calls[0]?.settings.permissionMode).toBe('default');
  });

  it('bypass with allowBypass true but runtime without it → unsupported_capability', async () => {
    const u = await make([fake([], { ...RICH, permissionModes: ['default'] })], { security: { allowBypass: true } });
    const s = await u.sessions.create({ runtime: 'fake' });
    await expect(u.sessions.updateSettings(s.id, { permissionMode: 'bypassPermissions' })).rejects.toMatchObject({
      code: 'unsupported_capability',
    });
  });

  it('effort not in capabilities → unsupported_capability', async () => {
    const u = await make([fake()]);
    const s = await u.sessions.create({ runtime: 'fake' });
    await expect(u.sessions.updateSettings(s.id, { effort: 'max' })).rejects.toMatchObject({
      code: 'unsupported_capability',
    });
    await expect(u.sessions.updateSettings(s.id, { model: 'gpt-x' })).rejects.toMatchObject({
      code: 'unsupported_capability',
    });
    await expect(u.sessions.updateSettings(s.id, { model: '' })).rejects.toMatchObject({ code: 'invalid_request' });
    expect((await s.get()).settings).toEqual({ permissionMode: 'default' });
  });

  it('any model accepted when the runtime lists none', async () => {
    const u = await make([fake([], { ...RICH, models: [] })]);
    const s = await u.sessions.create({ runtime: 'fake' });
    expect((await u.sessions.updateSettings(s.id, { model: 'custom-model' })).settings.model).toBe('custom-model');
  });

  it('read-only session → session_read_only; unknown session → not_found', async () => {
    await expect((await make([fake()])).sessions.updateSettings('ses_missing', { effort: 'low' })).rejects.toMatchObject({
      code: 'not_found',
    });
    const lost = createFakeAdapter({ id: 'lost', script: [], capabilities: RICH });
    lost.run = async function* () {
      yield { type: 'native.session_lost', message: 'gone' };
    };
    const u = await make([lost]);
    const s = await u.sessions.create({ runtime: 'lost' });
    await s.startRun({ prompt: 'p' });
    await eventsUntil(s, isTerminal);
    expect((await s.get()).readOnly).toBe(true);
    await expect(u.sessions.updateSettings(s.id, { effort: 'low' })).rejects.toMatchObject({
      code: 'session_read_only',
    });
  });

  it('adapter receives settings at run start; later change does not affect running run', async () => {
    const adapter = fake([{ waitMs: 150 }, { text: 'done' }]);
    const u = await make([adapter]);
    const s = await u.sessions.create({ runtime: 'fake' });
    await u.sessions.updateSettings(s.id, { model: 'opus', permissionMode: 'acceptEdits' });
    await s.startRun({ prompt: 'one' });
    // Changed while the run is in progress: applies from the next run only.
    await u.sessions.updateSettings(s.id, { permissionMode: 'plan', effort: 'medium' });
    await eventsUntil(s, isTerminal);
    expect(adapter.calls[0]?.settings).toEqual({ model: 'opus', permissionMode: 'acceptEdits' });

    const all = await eventsUntil(s, isTerminal);
    await s.startRun({ prompt: 'two' });
    await eventsUntil(s, (e) => isTerminal(e) && e.sequence > (all.at(-1)?.sequence ?? 0));
    expect(adapter.calls[1]?.settings).toEqual({ model: 'opus', effort: 'medium', permissionMode: 'plan' });
  });
});

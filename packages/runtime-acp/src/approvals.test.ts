import type { PermissionOption, RequestPermissionRequest } from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';
import { permissionDecision, toPermissionResponse } from './approvals.js';

const options: PermissionOption[] = [
  { optionId: 'allow-once', name: 'Allow', kind: 'allow_once' },
  { optionId: 'allow-always', name: 'Always', kind: 'allow_always' },
  { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
  { optionId: 'reject-always', name: 'Never', kind: 'reject_always' },
];

const req = (toolCall: Partial<RequestPermissionRequest['toolCall']>, opts = options): RequestPermissionRequest => ({
  sessionId: 's',
  toolCall: { toolCallId: 'c1', ...toolCall },
  options: opts,
});

const base = { mode: 'default' as const, allowBypass: false, siteToolNames: new Set<string>(), cwd: '/w' };

describe('permissionDecision', () => {
  it('asks in default mode with an allow_once / deny card and the target', () => {
    expect(permissionDecision(req({ title: 'npm test', kind: 'execute', rawInput: { command: 'npm test' } }), base)).toEqual({
      ask: {
        toolId: 'c1',
        category: 'shell',
        title: 'npm test',
        availableDecisions: ['allow_once', 'deny'],
        target: { command: 'npm test', cwd: '/w' },
      },
    });
    expect(permissionDecision(req({ title: 'Write a', kind: 'edit', locations: [{ path: '/w/a' }] }), base)).toMatchObject({
      ask: { category: 'file', target: { path: '/w/a' } },
    });
  });

  it('uses what the mapper knows when the request omits fields', () => {
    const known = { title: 'ls', kind: 'execute' as const, input: { command: ['ls', '-la'] } };
    expect(permissionDecision(req({}), { ...base, known })).toMatchObject({ ask: { title: 'ls', category: 'shell', target: { command: 'ls -la' } } });
  });

  it('acceptEdits auto-allows edit, delete and move, and asks for anything else', () => {
    const o = { ...base, mode: 'acceptEdits' as const };
    for (const kind of ['edit', 'delete', 'move'] as const) expect(permissionDecision(req({ kind }), o)).toEqual({ auto: 'allow' });
    for (const kind of ['execute', 'read', 'fetch', 'other'] as const) expect(permissionDecision(req({ kind }), o)).toHaveProperty('ask');
    expect(permissionDecision(req({}, options), { ...o, known: { title: 'x', kind: 'edit' } })).toEqual({ auto: 'allow' });
  });

  it('bypassPermissions auto-allows only when the local policy allows bypass; otherwise asks', () => {
    const o = { ...base, mode: 'bypassPermissions' as const };
    expect(permissionDecision(req({ kind: 'execute' }), { ...o, allowBypass: true })).toEqual({ auto: 'allow' });
    expect(permissionDecision(req({ kind: 'execute' }), o)).toHaveProperty('ask');
    expect(permissionDecision(req({ kind: 'edit' }), o)).toHaveProperty('ask');
  });

  it('a site tool (mcp__site__<n> or <n>) is auto-allowed: its MCP handler confirms', () => {
    const o = { ...base, siteToolNames: new Set(['publish']) };
    expect(permissionDecision(req({ title: 'mcp__site__publish' }), o)).toEqual({ auto: 'allow' });
    expect(permissionDecision(req({ title: 'publish' }), o)).toEqual({ auto: 'allow' });
    expect(permissionDecision(req({ title: 'Publish', kind: 'other' }), { ...o, known: { title: 'mcp__site__publish' } })).toEqual({ auto: 'allow' });
    expect(permissionDecision(req({ title: 'mcp__site__other' }), o)).toHaveProperty('ask');
    expect(permissionDecision(req({ title: 'mcp__evil__publish' }), o)).toHaveProperty('ask');
  });

  it('without an allow_once option the request is cancelled with a warning (never allow_always)', () => {
    const noOnce = options.filter((x) => x.kind !== 'allow_once');
    for (const o of [base, { ...base, mode: 'bypassPermissions' as const, allowBypass: true }]) {
      expect(permissionDecision(req({ kind: 'execute' }, noOnce), o)).toEqual({ auto: 'cancel', warning: expect.stringMatching(/allow once/i) });
    }
  });
});

describe('toPermissionResponse', () => {
  it('allow → allow_once, deny → reject_once, expired / cancelled → cancelled; never an *_always option', () => {
    expect(toPermissionResponse('allow', options)).toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } });
    expect(toPermissionResponse({ decision: 'allow' }, options)).toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } });
    expect(toPermissionResponse({ decision: 'deny' }, options)).toEqual({ outcome: { outcome: 'selected', optionId: 'reject-once' } });
    expect(toPermissionResponse({ decision: 'expired' }, options)).toEqual({ outcome: { outcome: 'cancelled' } });
    expect(toPermissionResponse({ decision: 'cancelled' }, options)).toEqual({ outcome: { outcome: 'cancelled' } });
    const always = options.filter((x) => x.kind.endsWith('always'));
    expect(toPermissionResponse('allow', always)).toEqual({ outcome: { outcome: 'cancelled' } });
    expect(toPermissionResponse({ decision: 'deny' }, always)).toEqual({ outcome: { outcome: 'cancelled' } });
  });
});

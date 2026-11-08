import { homedir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { connectedHome, daemonHomeConflict } from './home.js';

describe('UNCAGE_HOME (Connected Mode home override)', () => {
  it('defaults to the real home directory', () => {
    expect(connectedHome({})).toBe(homedir());
    expect(connectedHome({ UNCAGE_HOME: '' })).toBe(homedir());
  });

  it('uses an absolute UNCAGE_HOME for ~/.uncage and ~/Uncage, leaving HOME (Claude Code login) alone', () => {
    expect(connectedHome({ UNCAGE_HOME: '/tmp/uncage-test-home' })).toBe('/tmp/uncage-test-home');
  });

  it('rejects a relative UNCAGE_HOME', () => {
    expect(() => connectedHome({ UNCAGE_HOME: 'rel/dir' })).toThrow(/absolute/);
  });

  it('setup with UNCAGE_HOME requires --no-daemon (launchd would not see the override)', () => {
    expect(daemonHomeConflict({ UNCAGE_HOME: '/tmp/x' }, false)).toMatch(/--no-daemon/);
    expect(daemonHomeConflict({ UNCAGE_HOME: '/tmp/x' }, true)).toBeNull();
    expect(daemonHomeConflict({}, false)).toBeNull();
  });
});

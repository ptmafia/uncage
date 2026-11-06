import type { RuntimeCapabilities, SessionSettings } from '@uncage/protocol';
import { UncageError } from './errors.js';

export interface SecurityPolicy {
  /** `bypassPermissions` is only offered and accepted when true. Default false. */
  allowBypass: boolean;
}

/** Applies the security policy to runtime capabilities: without `allowBypass`, bypass is never advertised. */
export function applyPolicy(caps: RuntimeCapabilities, policy: SecurityPolicy): RuntimeCapabilities {
  if (policy.allowBypass || !caps.permissionModes.includes('bypassPermissions')) return caps;
  return { ...caps, permissionModes: caps.permissionModes.filter((m) => m !== 'bypassPermissions') };
}

/**
 * Validates a settings patch against the policy (first) and the runtime's capabilities, and
 * returns the merged settings. Keys absent from the patch keep their current value.
 */
export function mergeSettings(
  current: SessionSettings,
  patch: Partial<SessionSettings>,
  caps: RuntimeCapabilities,
  policy: SecurityPolicy,
): SessionSettings {
  if (patch.permissionMode === 'bypassPermissions' && !policy.allowBypass) {
    throw new UncageError('policy_denied', {
      message: 'Bypass permissions mode is disabled on this server.',
      hint: 'Enable security.allowBypass (or UNCAGE_ALLOW_BYPASS=1) on the server to allow it.',
    });
  }
  const unsupported = (key: string, value: string) =>
    new UncageError('unsupported_capability', {
      message: `The runtime does not support ${key} "${value}".`,
      details: { [key]: value },
    });
  if (patch.model !== undefined) {
    if (patch.model.trim() === '') throw new UncageError('invalid_request', { message: 'model must not be empty.' });
    if (caps.models.length > 0 && !caps.models.some((m) => m.id === patch.model)) throw unsupported('model', patch.model);
  }
  if (patch.effort !== undefined && !caps.efforts.includes(patch.effort)) throw unsupported('effort', patch.effort);
  if (patch.permissionMode !== undefined && !caps.permissionModes.includes(patch.permissionMode)) {
    throw unsupported('permissionMode', patch.permissionMode);
  }
  return {
    ...current,
    ...(patch.model !== undefined ? { model: patch.model } : {}),
    ...(patch.effort !== undefined ? { effort: patch.effort } : {}),
    ...(patch.permissionMode !== undefined ? { permissionMode: patch.permissionMode } : {}),
  };
}

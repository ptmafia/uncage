import { z } from 'zod';

export const ErrorCodeSchema = z.enum([
  'runtime_unavailable',
  'auth_required',
  'unsupported_capability',
  'invalid_workspace',
  'session_busy',
  'session_read_only',
  'not_found',
  'unauthorized',
  'forbidden_origin',
  'invalid_request',
  'approval_expired',
  'approval_already_resolved',
  'event_replay_unavailable',
  'runtime_disconnected',
  'policy_denied',
  'store_locked',
  'attachment_too_large',
  'attachment_type_unsupported',
  'machine_offline',
  'machine_not_found',
  'upgrade_required',
  'tool_failed',
  'device_code_expired',
  'rate_limited',
  'internal_error',
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const ErrorBodySchema = z.object({
  code: ErrorCodeSchema,
  message: z.string(),
  hint: z.string().optional(),
  retryable: z.boolean(),
  details: z.record(z.string(), z.unknown()).optional(),
  requestId: z.string().optional(),
});
export type ErrorBody = z.infer<typeof ErrorBodySchema>;

export interface ErrorCatalogEntry {
  status: number;
  message: string;
  hint: string;
  retryable: boolean;
}

export const ERROR_CATALOG: Record<ErrorCode, ErrorCatalogEntry> = {
  runtime_unavailable: {
    status: 503,
    message: 'The requested runtime is not available.',
    hint: 'Install the runtime CLI and make sure it is on your PATH.',
    retryable: false,
  },
  auth_required: {
    status: 401,
    message: 'The runtime requires authentication.',
    hint: 'Sign in to the runtime CLI (for example by running its login command) and retry.',
    retryable: false,
  },
  unsupported_capability: {
    status: 422,
    message: 'The runtime does not support this capability.',
    hint: 'Check the runtime capabilities before requesting this feature.',
    retryable: false,
  },
  invalid_workspace: {
    status: 400,
    message: 'The workspace path is invalid or not allowed.',
    hint: 'Use an existing directory inside an allowed workspace root.',
    retryable: false,
  },
  session_busy: {
    status: 409,
    message: 'The session already has an active run.',
    hint: 'Wait for the active run to finish or cancel it first.',
    retryable: true,
  },
  session_read_only: {
    status: 409,
    message: 'The session is read-only.',
    hint: 'Create a new session to continue working.',
    retryable: false,
  },
  not_found: {
    status: 404,
    message: 'The requested resource was not found.',
    hint: 'Check the identifier and try again.',
    retryable: false,
  },
  unauthorized: {
    status: 401,
    message: 'Missing or invalid authorization token.',
    hint: 'Send the daemon token in the Authorization header.',
    retryable: false,
  },
  forbidden_origin: {
    status: 403,
    message: 'The request origin is not allowed.',
    hint: 'Add the origin to the daemon allowed origins.',
    retryable: false,
  },
  invalid_request: {
    status: 400,
    message: 'The request body or parameters are invalid.',
    hint: 'Check the request against the API schema.',
    retryable: false,
  },
  approval_expired: {
    status: 410,
    message: 'The approval request has expired.',
    hint: 'Ask the agent to try the action again to get a fresh approval request.',
    retryable: false,
  },
  approval_already_resolved: {
    status: 409,
    message: 'The approval request was already resolved.',
    hint: 'Refresh the session to see the current approval state.',
    retryable: false,
  },
  event_replay_unavailable: {
    status: 410,
    message: 'The requested events are no longer available for replay.',
    hint: 'Fetch a fresh session snapshot and resume from its last sequence.',
    retryable: false,
  },
  runtime_disconnected: {
    status: 502,
    message: 'The runtime process disconnected unexpectedly.',
    hint: 'Start a new run; the session history is preserved.',
    retryable: true,
  },
  policy_denied: {
    status: 403,
    message: 'The action was denied by policy.',
    hint: 'Adjust the approval policy if this action should be allowed.',
    retryable: false,
  },
  store_locked: {
    status: 423,
    message: 'The local data store is locked by another process.',
    hint: 'Stop the other Uncage daemon using this data directory and retry.',
    retryable: true,
  },
  attachment_too_large: {
    status: 413,
    message: 'The attachment is too large.',
    hint: 'Attach files of at most 10 MB each.',
    retryable: false,
  },
  attachment_type_unsupported: {
    status: 415,
    message: 'This attachment type is not supported.',
    hint: 'Attach a png, jpg, jpeg, gif or webp image, or a supported text, code or pdf file.',
    retryable: false,
  },
  machine_offline: {
    status: 409,
    message: 'The machine is offline.',
    hint: 'Make sure the Uncage agent is running on that machine and connected to the internet.',
    retryable: true,
  },
  machine_not_found: {
    status: 404,
    message: 'The machine was not found.',
    hint: 'Check the machine id or connect the machine again.',
    retryable: false,
  },
  upgrade_required: {
    status: 426,
    message: 'The Uncage agent is too old for this hub.',
    hint: 'Upgrade the agent (npm i -g @uncage/cli) and reconnect.',
    retryable: false,
  },
  tool_failed: {
    status: 502,
    message: 'The tool call failed.',
    hint: 'Check the tool output for details and retry.',
    retryable: true,
  },
  rate_limited: {
    status: 429,
    message: 'Too many requests.',
    hint: 'Wait a moment and try again.',
    retryable: true,
  },
  device_code_expired: {
    status: 410,
    message: 'The device code has expired.',
    hint: 'Start the connection flow again to get a new code.',
    retryable: false,
  },
  internal_error: {
    status: 500,
    message: 'An internal error occurred.',
    hint: 'Check the daemon logs and report the request id if the problem persists.',
    retryable: false,
  },
};

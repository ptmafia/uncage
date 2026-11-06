import type { ErrorBody, ErrorCode } from '@uncage/protocol';

/**
 * `details.reason` values the client and proxy attach so UIs can tell transport failures apart:
 * `network` (the request never got a response), `http_status` (a non-JSON error response;
 * `details.status`), `daemon_unreachable` (the proxy has no token or cannot reach the daemon).
 */
export const ERROR_REASONS = {
  network: 'network',
  httpStatus: 'http_status',
  daemonUnreachable: 'daemon_unreachable',
} as const;

export class UncageClientError extends Error {
  readonly code: ErrorCode;
  readonly hint?: string;
  readonly status: number;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(body: Pick<ErrorBody, 'code' | 'message' | 'retryable' | 'hint' | 'details'>, status: number) {
    super(body.message);
    this.name = 'UncageClientError';
    this.code = body.code;
    this.status = status;
    this.retryable = body.retryable;
    if (body.hint !== undefined) this.hint = body.hint;
    if (body.details !== undefined) this.details = body.details;
  }
}

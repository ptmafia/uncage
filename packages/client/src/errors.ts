import type { ErrorBody, ErrorCode } from '@uncage/protocol';

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

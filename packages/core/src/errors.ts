import { ERROR_CATALOG, type ErrorBody, type ErrorCode } from '@uncage/protocol';

export class UncageError extends Error {
  code: ErrorCode;
  hint?: string;
  retryable: boolean;
  status: number;
  details?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    opts: { message?: string; hint?: string; details?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    const entry = ERROR_CATALOG[code];
    super(opts.message ?? entry.message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'UncageError';
    this.code = code;
    this.hint = opts.hint ?? entry.hint;
    this.retryable = entry.retryable;
    this.status = entry.status;
    if (opts.details !== undefined) this.details = opts.details;
  }

  toBody(requestId?: string): ErrorBody {
    return {
      code: this.code,
      message: this.message,
      ...(this.hint !== undefined ? { hint: this.hint } : {}),
      retryable: this.retryable,
      ...(this.details !== undefined ? { details: this.details } : {}),
      ...(requestId !== undefined ? { requestId } : {}),
    };
  }
}

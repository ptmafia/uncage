import type { Logger as PinoLogger } from 'pino';

/** The subset of a Pino logger that core uses. Never log prompt text at info level. */
export type Log = Pick<PinoLogger, 'debug' | 'info' | 'warn' | 'error'>;

const noop = (): void => undefined;
export const silentLog: Log = { debug: noop, info: noop, warn: noop, error: noop };

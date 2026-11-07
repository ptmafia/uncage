/**
 * The Local Mode daemon as a library: `createUncageServer` serves an `@uncage/core` instance over
 * REST + SSE. The same-origin proxy for your app is in `@uncage/server/proxy`.
 *
 * @module daemon
 */
export { createUncageServer, DEFAULT_PORT, type ServerOptions, type UncageServer } from './app.js';

/**
 * `@uncage/hub/node`: the Node-only parts of the hub for traditional mode — a Node
 * `(req, res, next?)` adapter, machine WebSockets on a Node HTTP server, and the embedded
 * single-node PGlite store. The root `@uncage/hub` entry stays Web-standard only.
 *
 * @module node
 */
export { toNodeHandler, type UncageNodeHandler } from './node-handler.js';
export { attachWebSocket } from './ws.js';
export { pgliteHubStore } from '../store/pglite.js';

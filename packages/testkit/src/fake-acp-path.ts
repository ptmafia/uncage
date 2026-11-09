import { fileURLToPath } from 'node:url';

/**
 * Absolute path of the built fake ACP agent (`dist/fake-acp.js`); run it with `node`.
 * Env: FAKE_ACP_CAPS (JSON agentCapabilities), FAKE_ACP_PROTOCOL, FAKE_ACP_IGNORE_CANCEL=1, FAKE_ACP_AUTH=required,
 * FAKE_ACP_RECORD (JSONL of every received message). See src/fake-acp/server.ts.
 */
export const fakeAcpPath: string = fileURLToPath(new URL('./fake-acp.js', import.meta.url));

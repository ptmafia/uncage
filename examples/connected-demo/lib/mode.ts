/**
 * The demo runs one codebase in two modes, decided by the entry that started it:
 *
 * - **traditional** — `node server.ts` (Railway, Docker, `pnpm dev`): one long-running Node process
 *   that creates the hub at start-up, publishes it (lib/hub-registry.ts), and serves the machines'
 *   WebSockets. Zero external dependencies: PGlite and files under the data dir.
 * - **faas** — `next start` / `next dev` with no custom server, or Vercel: the route handler
 *   `app/api/uncage/[[...path]]/route.ts` builds the hub on first use; machines connect over HTTP
 *   streaming. Nothing may live on local disk, so Postgres (`DATABASE_URL`) and a cookie key from
 *   the environment (`DEMO_SECRET`) are required.
 *
 * No setting picks the mode: whoever started the process did.
 */
const HUB_KEY = Symbol.for('uncage.connected-demo.hub');

export type DemoMode = 'traditional' | 'faas';

/** HMAC-SHA256 keys shorter than this are guessable. */
export const MIN_SECRET_BYTES = 32;

/** `traditional` when server.ts published its hub in this process, otherwise `faas`. */
export function demoMode(): DemoMode {
  return (globalThis as Record<symbol, unknown>)[HUB_KEY] ? 'traditional' : 'faas';
}

/** @internal Where server.ts publishes its hub (lib/hub-registry.ts). */
export const PUBLISHED_HUB_KEY = HUB_KEY;

/**
 * FaaS mode keeps nothing on local disk: throws, naming every missing variable, unless
 * `DATABASE_URL` and a `DEMO_SECRET` of at least 32 bytes are set.
 */
export function requireFaasEnv(env: Record<string, string | undefined> = process.env): void {
  const problems: string[] = [];
  if (!env.DATABASE_URL?.trim()) problems.push('DATABASE_URL (Postgres: the hub, the assets and the rate limits live there)');
  if (!env.DEMO_SECRET) problems.push(`DEMO_SECRET (the sign-in cookie key, at least ${MIN_SECRET_BYTES} bytes: openssl rand -base64 48)`);
  else if (new TextEncoder().encode(env.DEMO_SECRET).byteLength < MIN_SECRET_BYTES) {
    problems.push(`DEMO_SECRET is shorter than ${MIN_SECRET_BYTES} bytes (generate one with: openssl rand -base64 48)`);
  }
  if (problems.length > 0) {
    throw new Error(
      `The demo runs in FaaS mode (started without server.ts, e.g. \`next start\` or Vercel), where nothing is kept on local disk. Missing or invalid environment variables:\n  - ${problems.join('\n  - ')}\nSet them, or start the traditional server with \`node server.ts\` (pnpm start).`,
    );
  }
}

/**
 * FaaS mode caps attachments sent through the website at 4 MB: Vercel refuses request bodies over
 * ~4.5 MB before the function runs (a platform 413 the chat cannot explain), so the route answers
 * anything between with the hub's own `attachment_too_large` error instead. Traditional mode keeps
 * the hub's default (10 MB). Agent uploads and file pulls are chunked (≤ 1 MB bodies) and unaffected.
 */
export const FAAS_ATTACHMENT_MAX_BYTES = 4 * 1024 * 1024;

const ATTACHMENT_PATH = /^\/api\/uncage\/sessions\/[^/]+\/attachments\/?$/;

/** The 413 for an attachment upload over FAAS_ATTACHMENT_MAX_BYTES (by `Content-Length`), else null. */
export function faasAttachmentLimit(req: Request): Response | null {
  if (req.method !== 'POST' || !ATTACHMENT_PATH.test(new URL(req.url).pathname)) return null;
  const length = Number(req.headers.get('content-length'));
  // No Content-Length (chunked): the hub's own limit still applies; Vercel caps the body anyway.
  if (!Number.isFinite(length) || length <= FAAS_ATTACHMENT_MAX_BYTES) return null;
  return Response.json(
    {
      error: {
        code: 'attachment_too_large',
        message: `Attachments sent through this website can be at most ${FAAS_ATTACHMENT_MAX_BYTES} bytes.`,
        details: { maxBytes: FAAS_ATTACHMENT_MAX_BYTES },
        retryable: false,
      },
    },
    { status: 413 },
  );
}

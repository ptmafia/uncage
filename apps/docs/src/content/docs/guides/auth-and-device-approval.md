---
title: Auth and device approval
description: Connect the hub to your sign-in with getUser, and build the /device approval page safely (signed-in only, frame-ancestors 'none', CSRF-protected POST), in Next.js or any Node server.
---

The hub has no accounts of its own. It asks your website who is signed in, and it asks your website’s approval page to link a computer to that person.

## `getUser(req)`

`getUser` receives every browser request to the hub as a Fetch `Request` and returns the signed-in user, or `null`:

```ts nocheck
getUser(req: Request): Promise<{ id: string; name?: string } | null>
```

- `id` must be stable and unique per user: the hub stores machines, sessions and tool-call records under it, and passes it to your tool handlers as `ctx.user.id`.
- `name` is optional, for display.
- Returning `null` makes the request fail with `401 unauthorized`. The device endpoints the CLI uses (`/device/code`, `/device/token`, `/machine/revoke`) and `install.sh` are public and never call `getUser`.
- It runs on every request (including each SSE connection), so make it fast: a signed-cookie check or a cached session lookup.

### From a session cookie

Most sign-in libraries keep a session id or a signed token in a cookie. Read it from the `Cookie` header:

```ts title="auth.ts"
import type { HubUser } from '@uncage/hub';

/** Your session store: session id → user. */
declare function findSession(sessionId: string): Promise<{ userId: string; displayName: string } | null>;

function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.get('cookie') ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq !== -1 && part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

export async function getUser(req: Request): Promise<HubUser | null> {
  const sid = readCookie(req, 'session_id');
  if (!sid) return null;
  const session = await findSession(sid);
  return session ? { id: session.userId, name: session.displayName } : null;
}
```

If your library gives you a helper that takes a Fetch `Request` (many do), call it directly. The `examples/connected-demo` app uses an HMAC-signed cookie; see its `lib/auth.ts`.

### Cookies and CSRF

The browser API is authenticated by your cookies, so the hub protects it against cross-site requests: a non-GET request whose `Origin` is neither `publicUrl` nor the request’s own host, or that is marked `Sec-Fetch-Site: cross-site`, gets `403 forbidden_origin`. Keep your session cookie `SameSite=Lax` (or `Strict`) and `Secure` as well.

## The approval page (`/device`)

`uncage setup https://your.site` opens `https://your.site/device?code=ABCD-2345`. Change the path with the `verificationPath` option. On that page the signed-in user approves or denies the code. **Approving gives that computer access to the user’s account**, so the page is a target for clickjacking and CSRF. It must:

1. **Require the normal signed-in session.** If the user is not signed in, send them to your login page and back.
2. **Refuse framing:** `Content-Security-Policy: frame-ancestors 'none'` and `X-Frame-Options: DENY`.
3. **Decide with a CSRF-protected POST.** Never approve from a GET, or from the link alone.
4. **Show what is being approved:** the computer’s name and OS, and when and from which IP the code was requested (`requestedAt`, `requestIp`), all from `hub.lookupDevice`.
5. **Never trust a code that arrived in the link.** Warn, and enable Approve only after the user typed the code’s last 4 characters from their own terminal (see [Phishing links](#phishing-links)).

### Phishing links

Anyone can run `uncage setup https://your.site` on **their own** computer and send one of your users the link it prints (or a QR code, or an app deep link). The page then opens pre-filled, and “check that the code matches your terminal” means nothing to someone who has no terminal. If the user approves, the sender’s computer is linked to the user’s account and receives their prompts, attachments and site-tool calls. The computer name and OS on the page come from the sender and prove nothing.

So a code from the URL is not trusted on its own:

- Show the warning “Only approve if you just ran `uncage setup` on a computer in front of you. Never approve a code someone sent you.”
- Show when the code was requested (relative time: a code someone sent is usually minutes old) and the IP as seen by the server (`requestIp`, from the hub’s client-IP resolution; `null`, and not shown, when the hub had no trusted client IP). The IP is coarse on purpose: no geolocation.
- Label the computer’s name and OS as reported by the computer, not verified. The hub drops a reported name or OS that contains the code’s last 4 characters, and strips control characters.
- Hide the code’s last 4 characters and enable Approve only once the user typed them from the terminal of a computer they are sitting at. An attacker may try to tell the user those characters (in the message, on the phone): never type characters someone gave you; choose Deny.
- Accept a code from the URL only in the exact shape the CLI prints (`ABCD-EFGH` or `ABCDEFGH`); anything else (extra dashes or spaces) is “not a valid link” and is not looked up, and the masked code is built from the compacted code.
- When the user typed the whole code on your page (no code in the URL), no extra step is needed. Never decide that from the URL itself.
- Deny stays one click.

`<ApproveDevice>` does all of this with `source="link"`, its default; pass `source="typed"` only for a code the user typed. `useDeviceApproval(code, { source })` does the same for your own screens.

The hub gives you three calls, each taking the code and the signed-in user:

| Call | Returns |
| --- | --- |
| `hub.lookupDevice(code, user)` | `{ name?, os?, expiresAt, requestedAt, requestIp, repairsMachine }` for a pending code, else `null`. `requestedAt` is when `uncage setup` asked for the code (ISO), `requestIp` the IP the hub saw then (or `null`). `repairsMachine` is set when approving would re-pair one of this user’s computers: it keeps its id and sessions, and its old token stops working. |
| `hub.approveDevice(code, user)` | `'ok'`, `'not_found'` or `'expired'` |
| `hub.denyDevice(code, user)` | `'ok'`, `'not_found'` or `'expired'` |

Codes are 8 characters from `ABCDEFGHJKMNPQRSTUVWXYZ23456789`, shown as `ABCD-2345`, and valid for 10 minutes. Case, spaces and the dash are ignored. Unknown codes count as failed guesses: after 10 in 10 minutes (`rateLimits.userCodeFailures`, `userCodeWindowMs`) these calls throw an error with `code: 'rate_limited'` (`details.retryAfterSec`).

`<ApproveDevice>` from `@uncage/react-ui` renders the page: the computer, the request time and IP, the code, the phishing warning and the last-4 input (`source="link"`, the default), a re-pair warning, Approve and Deny, and the result. It is presentational; you make the decision on the server. Pass a failed call’s error to its `error` prop: it is shown localized (for `rate_limited`: “Too many requests. Wait a moment and try again.”), above the buttons when there is a lookup, or instead of “This code is invalid or has expired” when `lookupDevice` itself failed and `lookup` is `null`.

### Next.js

The [Connected Mode quickstart](/docs/start/quickstart-connected/#7-the-approval-page) has the complete Next.js version: a server component that calls `lookupDevice`, a Server Action that calls `approveDevice` / `denyDevice` (Server Actions are POST-only and Next.js checks their `Origin`, which is the CSRF protection), a client component around `<ApproveDevice>`, and the headers in `next.config.ts`. The same pattern, with a real sign-in redirect, is in `examples/connected-demo/app/device/`.

Adding the headers only to the approval page:

```ts title="next.config.ts"
import type { NextConfig } from 'next';

const config: NextConfig = {
  async headers() {
    return [
      {
        source: '/device',
        headers: [
          { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
    ];
  },
};

export default config;
```

### Express (any Node server)

Without Server Actions, write two small endpoints and check the origin yourself. This is a complete server (`getUser` is the one from [above](#from-a-session-cookie)); the page itself can be any React page that renders `<ApproveDevice>` and calls these endpoints with `fetch`.

```ts title="server.ts"
import { createServer } from 'node:http';
import { createHub, type HubUser } from '@uncage/hub';
import { attachWebSocket, pgliteHubStore, toNodeHandler } from '@uncage/hub/node';
import express, { type NextFunction, type Request as ExpressRequest, type Response } from 'express';
import { getUser } from './auth.ts';

const PUBLIC_URL = process.env.PUBLIC_URL ?? 'http://localhost:3000';
const store = await pgliteHubStore({ dataDir: './.uncage-hub' });
const hub = await createHub({ publicUrl: PUBLIC_URL, getUser, store });

/** Your sign-in for Express requests (the same session as getUser). */
declare function userOf(req: ExpressRequest): Promise<HubUser | null>;

const app = express();
app.use(toNodeHandler(hub));
app.use(express.json());

// Never framed.
app.use('/device', (_req: ExpressRequest, res: Response, next: NextFunction) => {
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});

/** CSRF: state-changing requests must come from this site. */
function sameOrigin(req: ExpressRequest): boolean {
  const origin = req.get('origin');
  if (origin) return origin === new URL(PUBLIC_URL).origin;
  return req.get('sec-fetch-site') === 'same-origin';
}

app.get('/device/lookup', async (req, res) => {
  const user = await userOf(req);
  if (!user) return void res.status(401).json({ code: 'unauthorized' });
  const code = String(req.query.code ?? '');
  try {
    res.json({ lookup: code ? await hub.lookupDevice(code, user) : null });
  } catch (e) {
    const err = e as { code?: string; message?: string };
    res.status(err.code === 'rate_limited' ? 429 : 500).json({ code: err.code ?? 'internal_error', message: err.message });
  }
});

app.post('/device/decision', async (req, res) => {
  if (!sameOrigin(req)) return void res.status(403).json({ code: 'forbidden_origin' });
  const user = await userOf(req);
  if (!user) return void res.status(401).json({ code: 'unauthorized' });
  const { code, approve } = req.body as { code?: unknown; approve?: unknown };
  if (typeof code !== 'string' || typeof approve !== 'boolean') return void res.status(400).json({ code: 'invalid_request' });
  try {
    const result = approve ? await hub.approveDevice(code, user) : await hub.denyDevice(code, user);
    res.json({ result }); // 'ok' | 'not_found' | 'expired'
  } catch (e) {
    const err = e as { code?: string; message?: string };
    res.status(err.code === 'rate_limited' ? 429 : 500).json({ code: err.code ?? 'internal_error', message: err.message });
  }
});

const server = createServer(app);
attachWebSocket(hub, server);
server.listen(3000);
```

On the page, call `GET /device/lookup?code=…`, render `<ApproveDevice code lookup state error onApprove onDeny />` (a code from the URL keeps the default `source="link"`), and `POST /device/decision` with `{ code, approve }` (the browser sends `Origin` on `fetch` POSTs). Map the answers to `ApproveDevice`’s `state`: `'ok'` → `'approved'` or `'denied'`; `'not_found'` and `'expired'` as they are; errors go to its `error` prop (the buttons stay enabled for a retry; with `lookup: null` the error replaces the “code not found” message).

## Revoking computers

- **From your website:** `<AgentChat>`’s computer menu lists the user’s computers. In your own UI, `useMachines().revoke(id)` or `DELETE <basePath>/machines/:id`. On the server: `await hub.revokeMachine(machineId, user)` (throws `machine_not_found` for someone else’s or unknown id).
- **From the computer:** `uncage sites remove <site id>` revokes it on the website with its own token and removes the token locally.

Either way the token stops working immediately and the computer is disconnected. Its sessions stay in your store (and on the computer).

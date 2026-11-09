---
title: "Authenticate apps"
description: "How a mobile app or other native client signs in to your hub: your getUser reads an Authorization bearer token that you issue, apps send no cookies and no Origin, and a website request from a foreign Origin is still refused."
---

The hub never issues credentials for users. For apps, `getUser(req)` does what it does for the website: it returns the signed-in user, or `null`. The only difference is where it looks: an `Authorization: Bearer <token>` header instead of a cookie.

## What the hub does with an app request

- A request with **no `Origin` header** (every native HTTP stack) passes the cross-site guard on every browser-API route, state-changing ones included. CSRF is a browser problem: only a browser attaches cookies to a request made by another site, and a browser always sends `Origin` on such a request.
- A request with a **foreign `Origin`** (a web page on another site) is still refused with `403 forbidden_origin`, even with a valid cookie.
- A bearer header is never added by a browser on its own, so a token cannot be abused through CSRF.

So: let `getUser` accept either a cookie or a bearer token, and never trust the `Origin` yourself.

## `getUser` with a bearer token

```ts title="auth.ts"
import type { HubUser } from '@uncage/hub';

/** Your token check: a signed token, an OAuth access token, a session id … → user or null. */
declare function userForToken(token: string): Promise<{ id: string; name: string } | null>;
/** Your cookie check (the web sign-in). */
declare function userForCookie(req: Request): Promise<{ id: string; name: string } | null>;

export async function getUser(req: Request): Promise<HubUser | null> {
  const header = req.headers.get('authorization');
  if (header !== null) {
    // A bearer header decides alone: an invalid token is never rescued by a cookie sent with it.
    const m = /^Bearer\s+(\S+)$/i.exec(header.trim());
    return m ? await userForToken(m[1]!) : null;
  }
  return userForCookie(req);
}
```

Issue the token from the sign-in you already have (OAuth, your session system, a magic link). Give it an expiry and a renewal route, store it in the platform keychain in the app (`expo-secure-store`), and send it with the client’s async `headers` option ([React Native apps](/docs/guides/react-native/#2-the-client)).

## The demo’s tokens

`examples/connected-demo` shows the minimum, **for a demo only**:

- `POST /api/app/token` returns `{ token, user, expiresAt }`. The token is `uat1.<username>.<expiry>.<hmac>`, valid 30 days, signed with a key derived from the cookie key under its own label, so a cookie is never a valid app token and the reverse. It answers, in this order: a renewal for a valid bearer token (an invalid one is `401`), the signed-in cookie user, on the public demo (`DEMO_PUBLIC=1`) a fresh random guest (at most 10 new guests per client IP per minute, then `429` with `Retry-After`), else `{ "username": "…" }` from the body (no password: demo only).
- It refuses a request with a foreign `Origin`, like every state-changing route.
- A real site issues tokens from its own authentication and verifies them in `getUser` as above.

## Checklist

- [ ] Tokens are random or signed, expire, and can be revoked; they are stored in the keychain, not in plain storage.
- [ ] `getUser` returns `null` for a bad bearer token; it does not fall back to a cookie.
- [ ] The token endpoint is rate limited and refuses foreign `Origin`s.
- [ ] You do not list `null` / `file://` or wildcards in `trustedOrigins`: apps do not need it ([browser extensions](/docs/guides/browser-extension/) do).

See also [auth and device approval](/docs/guides/auth-and-device-approval/) and the [security page](/docs/reference/security/#app-bearer-tokens).

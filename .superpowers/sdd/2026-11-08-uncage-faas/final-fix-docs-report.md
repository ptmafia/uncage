# Final fix wave: docs and site copy — report

Commit: ebe2d17 "docs: ACP and 0.3 migration notes, protocol 2 security page, honest platform copy, CI and deploy docs" (only my files staged).

## Items
1. DONE migrate-from-0-2 (en/zh-cn/ja): ACP auto-detect + handshake (off: runtimes.acp.autoDetect: false, presets: off), daily registry download (UNCAGE_ACP_REGISTRY_REFRESH=0), acp-* ids and skills 'prompt', stop all 0.2 nodes before 0.3 migrations (unique index).
2. DONE security.md (3 locales): transport rewritten for protocol 2 (WSS; HTTPS streaming with NDJSON, cursor acks, 10 s ping, rotation, bearer per request, 1 MiB, auth-failure limit, ~30 s offline), rate-limit counting now store-wide; new ACP section (consent bound to spec, registry trust, project config cannot consent, agents[].command runs without consent, no allow_always, loopback MCP + bearer, skills in .uncage/skills).
3. DONE site OS card and ACP card (en/zh/ja).
4. DONE flow label/wire and how.sub: WebSocket or HTTPS streaming (3 locales).
5. DONE README: sudo/admin claim qualified; demo prerequisite says macOS/Linux, Windows demo scripts not yet verified (conservative; adjust once the code agent's cross-platform scripts land).
6. DONE ci-and-releases (platform job, runtime-acp, deploy bullet now Vercel/Web check, ja pages), CONTRIBUTING (Vercel not Pages, zh-cn + ja, runtime-acp, new-in-0.3 note, localhost:4321/docs/), docs/deploy-web.md (Vercel FaaS demo option B, separate project, links DEPLOY.md).
7. DONE quickstart-local prerequisite (3 locales): macOS/Linux/Windows, macOS verified, Linux/Windows CI verified, real-device pending. (serve is the same CLI; no OS gate found in packages/cli.)
8. DONE first-publish note in ci-and-releases.

## Verification
- check-i18n strict: 64 pages, 0 warnings, 0 errors.
- pnpm --filter site test: 14 passed. Site e2e (system Chrome, incl. 320/360/375 no-overflow, all locales): 9 passed.
- pnpm build:web + pnpm check:web: ok (1526 pages, 0 missing). Note: running site e2e rebuilds apps/site/dist and wipes dist/docs; rebuild with build:web before check:web.
- Did not run `pnpm --filter docs build` separately (build:web includes it).

## Concerns
- zh/ja translated by me against the glossary; not reviewed by a native reviewer.
- Version strings untouched. deploy-web.md still has legacy wording in places about the connected-demo Vercel project.

## Round 2

Items M-3 to M-6 (docs side), en + zh-cn + ja, facts confirmed in code first.
- M-3 bodyTimeoutMs: idle timeout, 4x total cap in mount-the-hub, migrate-from-0-2, deploy/vercel (advice softened), troubleshooting, errors.
- M-4 logger: row in the mount-the-hub options table (console default, `{ warn() {}, error() {} }` silences, one-time no-cluster warning from toNextHandlers/fetchOnce), row in migrate "New options", and a migrate behavior bullet (0.2 silent, 0.3 logs).
- M-5: Retry-After on 429 (errors, troubleshooting); http-api offered-URL rule, closing-hub 500/503, only the hub's own 401 body revokes; troubleshooting bullet for Deployment Protection / Cloudflare Access 401 loops.
- M-6: security.md now says HTTP /agent/*, WebSocket upgrade and /machine/revoke (relies on the code agent's WS limiter change).
Verification: check-i18n strict 64 pages 0/0; pnpm build:web + check:web ok (1529 pages, 0 missing).
Concern: zh/ja unreviewed by natives; the security claim about WS needs the code change to land.

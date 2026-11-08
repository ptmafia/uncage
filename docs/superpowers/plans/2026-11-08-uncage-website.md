# Uncage Website + Trilingual Help Site + Hosted Demo — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An official site (`/`, `/zh/`, `/ja/`) plus the help site under `/docs/` (en / zh-CN / ja) as one Vercel deployment, and the connected demo deployable to Railway in public mode, verified with real Claude Code.

**Architecture:** New Astro static app `apps/site`; the existing Starlight app `apps/docs` moves to `base: '/docs'` and gains a `ja` locale; a root script builds both and copies the docs output into `apps/site/dist/docs`, which Vercel serves as one static output. Shared brand assets and CSS tokens live in `brand/` at the repo root. The demo (`examples/connected-demo`) gets public-mode hardening, a Dockerfile and Railway config.

**Tech Stack:** Astro 7 + Starlight 0.42 (existing), TypeScript 6, pnpm 10 + Turborepo, Next 16 (demo), Vitest, Playwright with **system Chrome** (`channel: 'chrome'`), Docker.

**Spec:** `docs/superpowers/specs/2026-11-08-uncage-website-design.md` (read it; §4.6 overrides earlier sections).

## Global Constraints

- Languages: `en` (default, unprefixed), `zh` (site) / `zh-cn` (Starlight locale key, `lang: zh-CN`), `ja`. Every user-facing string on the site exists in all three.
- Slogan: **Run your coding agent everywhere.** Tagline: *Local harness, as a service.* Secondary CTA: **Integrate in minutes** (never a number of minutes).
- Not-yet-built capabilities are features marked **Coming soon**: Codex verified on a real binary; Windows & Linux agents; more entry points (mobile, chat apps, browser extensions); serverless-ready transport (Vercel / Netlify). Never present them as available.
- Visual language: warm paper `#f7f3ec`, ink `#1f2328`, accent `#c4651a` (light) — the mockup `.superpowers/brainstorm/21292-1794114414/content/homepage-v1.html` is the approved reference.
- No external fonts, no third-party scripts, no analytics.
- Env: `SITE_URL` (canonical origin, default `https://uncage-dev.vercel.app`), `PUBLIC_DEMO_URL` (optional). Never hardcode a domain elsewhere.
- Docs internal links use `/docs/...`. Product paths like `/api/uncage/...` must never be rewritten.
- English-only docs pages: generated API, `reference/changelog`, `guides/ci-and-releases`.
- Translation rules: `apps/docs/i18n-glossary.md` is binding; code blocks identical to English byte-for-byte; terms/identifiers/commands stay English; UI labels match the real UI (zh UI: 允许执行 / 拒绝; the React UI has no Japanese strings → keep English labels in ja docs with a short gloss).
- Tests touching the agent use `UNCAGE_HOME` temp dirs, never the real `~/.uncage`. Never run real Codex. Never download browsers.
- Commits: conventional, end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Branch: `feat/site-and-demo-deploy`.

## Review Focus

1. A visitor on `/ja/` clicking Docs must land on `/docs/ja/`, and docs' language picker must keep the page — test in Task 6 link check.
2. Deep links with and without trailing slash (`/docs/guides/define-tools`, `/zh`) must resolve on Vercel — `cleanUrls`/`trailingSlash` config tested in Task 6 with a static server that mimics Vercel.
3. `PUBLIC_DEMO_URL` unset must not produce a dead CTA — Task 4 test.
4. Public demo: another guest fetching `/asset-files/<id>/index.html` gets 404 — Task 1 test.
5. A rewritten docs link regex must not touch `/api/uncage/` — Task 3 test.

---

### Task 1: Demo — public-mode hardening, cleanup, Railway packaging

**Files:**
- Modify: `examples/connected-demo/Dockerfile` (drop `VOLUME /data`), `examples/connected-demo/app/asset-files/[id]/[...path]/route.ts`, `examples/connected-demo/lib/assets.ts`, `examples/connected-demo/server.ts`, `examples/connected-demo/README.md`
- Create: `examples/connected-demo/railway.json`, `examples/connected-demo/DEPLOY.md`
- Test: `examples/connected-demo/lib/demo.test.ts`

**Interfaces:**
- Produces: `canReadAsset(asset: Asset, viewer: string | null, publicMode: boolean): boolean` and `purgeAssetsOlderThan(maxAgeMs: number, now?: number): Promise<number>` in `lib/assets.ts`.

- [ ] Step 1: tests — `canReadAsset`: non-public mode → true for any viewer on a published asset; public mode → true only when `viewer === asset.owner`; drafts → false always. `purgeAssetsOlderThan(24h)`: creates two assets, backdates one's `createdAt` by 25h in `meta.json`, expects return `1` and only the fresh one listed.
- [ ] Step 2: run `pnpm --filter connected-demo test` → FAIL.
- [ ] Step 3: implement both; route reads viewer via `userFromRequest(req)` and returns the same 404 body when `canReadAsset` is false (no existence leak). `server.ts`: when `isPublicDemo()`, call `purgeAssetsOlderThan(24h)` at start and every hour (`setInterval(...).unref()`), log the count.
- [ ] Step 4: tests PASS; `pnpm --filter connected-demo typecheck && lint`.
- [ ] Step 5: `railway.json`: `{ "$schema": "https://railway.com/railway.schema.json", "build": { "builder": "DOCKERFILE", "dockerfilePath": "examples/connected-demo/Dockerfile" }, "deploy": { "healthcheckPath": "/login", "restartPolicyType": "ON_FAILURE" } }`. `DEPLOY.md` (Chinese + English sections): Railway steps (New project → Deploy from GitHub repo → service Settings → Config-as-code path `examples/connected-demo/railway.json` → Variables `DEMO_PUBLIC=1`, `DOCS_URL=<site>/docs/`, optional `DEMO_SECRET` ≥32 bytes, `PUBLIC_URL` only if a custom domain → Networking → Generate Domain); what gets cleared and when (every deploy/restart; assets older than 24 h hourly); optional Volume at `/data` to persist; Render alternative (Docker, same vars, free tier sleeps). README: link DEPLOY.md and document `DEMO_PUBLIC`, `DOCS_URL`.
- [ ] Step 6: `docker build -f examples/connected-demo/Dockerfile -t uncage-connected-demo .` succeeds; commit.

### Task 2: Brand — logo set and shared tokens

**Files:**
- Create: `brand/logo-mark.svg`, `brand/logo-mark-dark.svg`, `brand/logo-horizontal.svg`, `brand/logo-horizontal-dark.svg`, `brand/favicon.svg`, `brand/tokens.css`, `brand/README.md`, `scripts/brand-png.mjs` (renders PNGs with system Chrome via Playwright: `favicon-32.png`, `apple-touch-icon.png` 180, `icon-512.png`, into `brand/png/`)
- Modify: `apps/docs/src/assets/logo-light.svg`, `apps/docs/src/assets/logo-dark.svg` (replace with brand marks), `apps/docs/astro.config.mjs` (favicon), `apps/docs/src/styles/custom.css` (map Starlight vars from tokens)

**Interfaces:**
- Produces: CSS custom properties in `brand/tokens.css`: `--uc-paper --uc-paper-2 --uc-ink --uc-ink-2 --uc-ink-3 --uc-line --uc-accent --uc-accent-soft --uc-code --uc-radius --uc-font-sans --uc-font-mono` (light under `:root`, dark under `[data-theme='dark']` and `@media (prefers-color-scheme: dark) :root:not([data-theme='light'])`).

- [ ] Step 1: draw the mark: refined open padlock (body ink, open shackle in accent), optically balanced on a 32 grid, stroke 2.4, works at 16 px; wordmark "Uncage" as outlined paths or system-sans text converted to paths (no font dependency).
- [ ] Step 2: `node scripts/brand-png.mjs` writes the PNGs; open them (Read tool) to check legibility at 32 px.
- [ ] Step 3: swap docs logo/favicon, map tokens; `pnpm --filter docs build` passes; commit.

### Task 3: Help site — `/docs` base, `ja` locale, glossary, parity check, Try-the-demo page

**Files:**
- Modify: `apps/docs/astro.config.mjs` (`site: process.env.SITE_URL ?? 'https://uncage-dev.vercel.app'`, `base: '/docs'`, locales add `ja: { label: '日本語', lang: 'ja' }`, links-validator excludes `/docs/llms*.txt`, `/docs/skills/**`, `/docs/**/*.md`, head llms link), `apps/docs/src/nav.mjs` (`SITE_URL` from env + `/docs`; each section gets `ja`; add `start/try-the-demo` after quickstart-local; mark English-only slugs), `apps/docs/src/lib/markdown.ts` (regex `/docs/`), all `apps/docs/src/content/docs/**/*.md` internal links `/uncage/` → `/docs/`, `apps/docs/scripts/check-snippets.ts` if it hardcodes paths, `README.md`/`CONTRIBUTING.md`/`skills/uncage/SKILL.md` docs URLs → `${SITE_URL}/docs/...` using `https://uncage-dev.vercel.app` placeholder.
- Create: `apps/docs/i18n-glossary.md` (en / zh-CN / ja fixed terms: hub, site tools, skills, Connected Mode, Local Mode, device approval, machine, run, session, approval card, workspace, local policy, activity log, manifest, permission mode, bypass), `apps/docs/scripts/check-i18n.ts` (for every non-English-only en page: zh-cn and ja files exist; fenced code blocks identical in order and content; exits 1 listing differences; `--allow-missing` flag used until Tasks 7–9 land), `apps/docs/src/content/docs/start/try-the-demo.mdx` (en) + `src/components/DemoLink.astro` (reads `import.meta.env.PUBLIC_DEMO_URL`; when unset renders the local-run instructions link instead of a button), screenshots copied from `/Users/nathan/Documents/Ptmind/uncage-demos/connected-npm/screenshots/` into `apps/docs/src/assets/demo/`.
- Test: `apps/docs/scripts/markdown.test.ts` (vitest) for the link rewrite.

- [ ] Step 1: test — `toMarkdownLinks('[a](/docs/guides/x/#h) [b](/api/uncage/agent)')` rewrites only the first to `${SITE_URL}/docs/guides/x.md#h`.
- [ ] Step 2: FAIL → implement → PASS.
- [ ] Step 3: rewrite links with a guarded regex `\]\(/uncage/` and `link: /uncage/` only; `grep -rn "/uncage/" apps/docs/src` afterwards must show only `/api/uncage/` occurrences.
- [ ] Step 4: write the glossary, `check-i18n.ts`, try-the-demo page (prereqs: macOS, Node ≥ 22, Claude Code signed in; what you will see with the 5 screenshots + captions; the two commands; data cleared on every deploy and after 24 h; run the demo locally link to the example README on GitHub).
- [ ] Step 5: package.json scripts: `check` = snippets + `check:i18n` + build; `pnpm --filter docs check` passes (with `--allow-missing`); commit.

### Task 4: Official site — scaffold, i18n framework, English homepage, SEO

**Files:**
- Create: `apps/site/` (`package.json` name `site`, private, scripts `dev|build|preview|check|typecheck|lint`; `astro.config.mjs` with `site: SITE_URL`, `i18n: { locales: ['en','zh','ja'], defaultLocale: 'en', routing: { prefixDefaultLocale: false } }`, `trailingSlash: 'ignore'`, `build.format: 'directory'`; `src/i18n/{en,zh,ja}.ts` dictionaries typed by `src/i18n/schema.ts` (`type Dict` — zh/ja must satisfy the same type, so a missing key is a type error); `src/i18n/index.ts` (`getDict(locale)`, `localePath(locale, path)`, `docsPath(locale, path)` → `/docs/` | `/docs/zh-cn/` | `/docs/ja/`); `src/layouts/Base.astro` (head: title, description, canonical, `hreflang` en/zh-CN/ja + x-default, OG/Twitter tags, favicon set, theme-color); `src/components/{Nav,Hero,FlowDiagram,Why,HowItWorks,Features,CodeSnippets,Security,FinalCta,Footer,LangSwitcher,LangHint}.astro`; `src/pages/index.astro`, `src/pages/[locale]/index.astro` (zh, ja via `getStaticPaths`), `src/pages/404.astro`; `src/pages/robots.txt.ts`; `@astrojs/sitemap` with i18n; `public/` brand PNGs + `og/og-{en,zh,ja}.png` (generated by `scripts/og.mjs` with system Chrome from an HTML template); `src/snippets/*.ts` holding the homepage code samples, imported raw into `CodeSnippets` and type-checked by `tsc` against `@uncage/hub` / `@uncage/react` / `@uncage/react-ui` workspace packages.
- Test: `apps/site/tests/i18n.test.ts` (vitest), `apps/site/tests/e2e.spec.ts` (Playwright, system Chrome, runs against `astro preview`).

**Interfaces:**
- Produces: `getDict(locale: 'en'|'zh'|'ja'): Dict`, `localePath(locale, path?: string): string`, `docsPath(locale, path?: string): string`, `demoHref(): string` (= `PUBLIC_DEMO_URL` ? docs try-the-demo page : same page — the CTA always goes to `docsPath(locale, 'start/try-the-demo/')`, the page itself holds the demo URL; spec §4.6).

- [ ] Step 1: vitest — `localePath('en','/')==='/'`, `localePath('zh','/')==='/zh/'`, `docsPath('ja','start/try-the-demo/')==='/docs/ja/start/try-the-demo/'`, `docsPath('zh')==='/docs/zh-cn/'`; dictionaries: every key of `en` has a non-empty string in `zh` and `ja` (deep walk), and no `zh`/`ja` value equals the English one except an allow-list (brand names, code, "GitHub", "npm", "MIT", slogan if kept English — decide per key and list it).
- [ ] Step 2: FAIL → implement framework + English copy from the mockup (use "Integrate in minutes"; add the serverless transport Coming soon card → features grid becomes 10 items: 6 available + 4 coming soon, laid out as two labelled groups "Available today" / "Coming soon").
- [ ] Step 3: build components to match the mockup at desktop and ≥360 px; FlowDiagram animates lines in sequence with CSS only, disabled under `prefers-reduced-motion`; copy buttons on commands (tiny inline script); LangHint: if `navigator.language` starts with zh/ja and the page locale differs and `localStorage['uc-lang-hint']` unset → dismissible bar linking to the same page in that language.
- [ ] Step 4: Playwright: `/` has `<html lang="en">`, h1 text "Run your coding agent everywhere."; nav Docs href `/docs/`; secondary CTA text "Integrate in minutes"; 4 elements with text "Coming soon"; hreflang links for zh-CN and ja present; no console errors; at 375×812 no horizontal scroll (`scrollWidth <= innerWidth`).
- [ ] Step 5: `pnpm --filter site check` (astro check + tsc + vitest) and e2e PASS; commit.

### Task 5: Official site — Chinese and Japanese

**Files:**
- Modify: `apps/site/src/i18n/zh.ts`, `apps/site/src/i18n/ja.ts`, `apps/site/scripts/og.mjs` outputs, `apps/site/tests/e2e.spec.ts`

- [ ] Step 1: write zh and ja copy as native marketing copy (not literal): same structure, same claims, Coming soon labels `即将推出` / `近日公開`; CJK typography: no spaces-as-separators inside CJK, half-width code, `font-feature-settings: "palt"` for ja headings, line-break rules (`word-break: auto-phrase` where supported, `line-break: strict`).
- [ ] Step 2: e2e — `/zh/` `lang="zh-CN"`, Docs link `/docs/zh-cn/`; `/ja/` `lang="ja"`, Docs link `/docs/ja/`; language switcher on `/ja/` links to `/` and `/zh/`; OG image meta per locale.
- [ ] Step 3: check + e2e PASS; screenshots of three homepages (desktop 1440, mobile 390) saved under `apps/site/screenshots/` (gitignored? no — commit them for review in the PR description? Keep out of git: write to `/tmp/uncage-site-shots/` and reference in the final report); commit.

### Task 6: One deployment — combined build, Vercel config, CI

**Files:**
- Create: `scripts/build-web.mjs` (runs `turbo run build --filter=docs^... --filter=site^...`, `pnpm --filter docs build`, `pnpm --filter site build`, copies `apps/docs/dist/` → `apps/site/dist/docs/`, fails if `apps/site/dist/docs/index.html` missing), `vercel.json` at repo root (`installCommand: "pnpm install --frozen-lockfile"`, `buildCommand: "node scripts/build-web.mjs"`, `outputDirectory: "apps/site/dist"`, `cleanUrls: false`, `trailingSlash: true`, headers: security headers on `/(.*)` — `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: DENY`, `Permissions-Policy: camera=(), microphone=(), geolocation=()`; long cache for `/_astro/(.*)` and `/docs/_astro/(.*)`), `scripts/check-web-links.mjs` (crawls `apps/site/dist` from `/`, `/zh/`, `/ja/`, `/docs/`, `/docs/zh-cn/`, `/docs/ja/` following same-origin links, resolving directory → `index.html`; fails on any missing target; external links ignored).
- Modify: root `package.json` (`"build:web": "node scripts/build-web.mjs"`, `"check:web": "node scripts/check-web-links.mjs"`), `.github/workflows/docs.yml` → rename job "Web", triggers `pull_request` + `push: main`, steps: install, `build:web`, `check:web`, `pnpm --filter docs check:snippets`, `check:i18n`; remove Pages permissions/deploy job; `turbo.json` unchanged unless outputs need `dist/**` (already).

- [ ] Step 1: run `pnpm build:web && pnpm check:web` → PASS with zero missing links; verify `/ja/` → Docs → `/docs/ja/` and Starlight's picker on `/docs/ja/guides/define-tools/` links to `/docs/guides/define-tools/` and `/docs/zh-cn/guides/define-tools/`.
- [ ] Step 2: `npx vercel build` is NOT available offline without login — instead serve `apps/site/dist` with a tiny static server honoring `trailingSlash: true` semantics and spot-check 10 URLs with curl (with/without trailing slash → 200 or 308 to slash form).
- [ ] Step 3: commit.

### Tasks 7–9: Help site translations (parallelizable; each follows the glossary and passes `check:i18n` for its files)

Every translated file: same frontmatter keys (title/description translated), same headings structure, same code blocks byte-for-byte, links pointing to the same-locale page (`/docs/zh-cn/...`, `/docs/ja/...`) when that page exists in that locale, otherwise the English page; English-only pages (API, changelog, ci-and-releases) linked in English.

- **Task 7 — zh-cn:** re-sync the 6 existing pages to current English, translate the remaining pages (all of `start/`, `concepts/`, `guides/` except ci-and-releases, `reference/` except changelog, `index`, `404`, `start/try-the-demo.mdx`).
- **Task 8 — ja part 1:** `index`, `404`, `start/*` (incl. try-the-demo), `concepts.md`, `concepts/trust-model`, `reference/glossary`.
- **Task 9 — ja part 2:** `guides/*` (except ci-and-releases), `reference/*` (except changelog, glossary).

- [ ] Step: translate; `pnpm --filter docs check:i18n` reports no differences for the task's files; `pnpm --filter docs build` passes; commit per task.
- After 7–9: drop `--allow-missing` from `check:i18n` in package.json and CI; `pnpm --filter docs check` passes.

### Task 10: End-to-end verification and delivery

- [ ] Step 1: demo container + real Claude Code: `docker run` with `DEMO_PUBLIC=1 PUBLIC_URL=http://localhost:3290`; `UNCAGE_HOME=$(mktemp -d) node packages/cli/dist/bin.js setup http://localhost:3290 --no-daemon` approved via Playwright on `/device`; `uncage agent` foreground; send "做一个介绍 Uncage 的落地页并发布"; approve file write + `publish_asset`; owner sees the asset; a second guest gets 404 on its `/asset-files/` URL; stop agent → offline. Record timings + screenshots in `/tmp/uncage-demo-shots/`.
- [ ] Step 2: Lighthouse (`npx lighthouse` with system Chrome `--chrome-path`, mobile) on `/`, `/ja/`, `/docs/guides/define-tools/` served from the static server: all four categories ≥ 95; fix and re-run until met.
- [ ] Step 3: full repo `pnpm build && pnpm exec turbo run test --concurrency=1 && pnpm typecheck && pnpm lint` green.
- [ ] Step 4: whole-branch review (subagent), fix findings.
- [ ] Step 5: write `docs/deploy-web.md` (zh): Vercel steps (reuse project `connected-demo`: Settings → General → Root Directory = repo root `./`, Framework = Other, Build/Install/Output from `vercel.json`, env `SITE_URL`, `PUBLIC_DEMO_URL`; rename project; optional custom domain), Railway steps (link to DEPLOY.md), then set `DOCS_URL` on Railway and `PUBLIC_DEMO_URL` on Vercel and redeploy. Push branch; prepare PR title/body at `/tmp/uncage-PR-website.md`.

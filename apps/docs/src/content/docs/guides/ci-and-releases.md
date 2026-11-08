---
title: Contributing, CI and releases
description: How to build and test the Uncage monorepo, what CI runs, how releases are published to npm with Changesets and trusted publishing, and how this help site is checked and deployed.
---

This page is for people working **on** Uncage. It follows [`CONTRIBUTING.md`](https://github.com/ptmafia/uncage/blob/main/CONTRIBUTING.md).

## Develop

The repository is a pnpm workspace (Node.js 22+, pnpm 10) built with Turborepo.

```sh
pnpm install
pnpm build && pnpm typecheck && pnpm lint && pnpm test
pnpm e2e:mock                    # Playwright against a fake runtime (uses your system Chrome)
UNCAGE_LIVE=1 pnpm e2e:live      # against REAL Claude Code (uses a little Claude usage; never in CI)
```

The E2E suites run TypeScript files directly with `node`, so they need Node.js 22.18 or newer. Locally they use your installed Google Chrome and never download a browser; in CI (`CI=true`) Playwright uses its bundled Chromium.

Connected Mode suites, from `e2e/` after `pnpm build`:

```sh
pnpm exec playwright test --project=connected-mock
UNCAGE_DOCKER_TESTS=1 pnpm exec playwright test --project=connected-multinode   # needs Docker
UNCAGE_LIVE=1 pnpm exec playwright test --project=connected-live               # real Claude Code
```

## What CI runs

`.github/workflows/ci.yml`, on every pull request and on pushes to `main` and `feat/**`:

| Job | Steps |
| --- | --- |
| **Node 22 / Node 24** | `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, then `pnpm e2e:mock` with Playwright’s Chromium |
| **platform** (Ubuntu, macOS, Windows) | `pnpm build` of the CLI and hub, then on each OS: the installers (`install.ps1` under Windows PowerShell 5.1 and pwsh 7, `install.sh` under bash with shellcheck on Ubuntu and bash 3.2 on macOS), the agent and CLI suites (paths, permissions, `.cmd` spawning), and the real per-user service on Windows (Task Scheduler) and Ubuntu (`systemd --user`), registered for the runner’s user and removed again |
| **Docs** (Node 24) | Build the packages the site documents, lint and type-check `apps/docs`, type-check every code sample on this site (`pnpm --filter docs check:snippets`), then build the site (`pnpm --filter docs build`), which also generates the API reference and validates every internal link |

## Releases

Releases are automatic, driven by [Changesets](https://github.com/changesets/changesets). All public `@uncage/*` packages share one version (a `fixed` group).

1. In every pull request with a user-visible change, run `pnpm changeset`, choose the bump, write a short note, and commit the generated `.changeset/*.md` file.
2. When the pull request merges to `main`, `.github/workflows/release.yml` opens (or updates) a “chore: version packages” pull request that bumps versions and writes changelogs.
3. Merging that pull request makes the same workflow run `changeset publish`, which publishes every unpublished version to npm (without provenance) and tags the release.

Publishing uses npm **trusted publishing** (OIDC). There is no `NPM_TOKEN` secret.

### One-time setup (maintainers)

- **npm, per public package** (`@uncage/protocol`, `core`, `server`, `client`, `react`, `react-ui`, `runtime-claude`, `runtime-codex`, `runtime-acp`, `cli`, `hub`, `agent`): npmjs.com → the package → Settings → Trusted publishing → GitHub Actions, with organization `ptmafia`, repository `uncage`, workflow `release.yml`, environment empty. A package that was never published has no settings page yet: publish it once by hand (`pnpm build`, then `pnpm --filter @uncage/hub publish --access public --no-git-checks` while logged in with `npm login`), then configure trusted publishing.
- **GitHub:** in the organization (Settings → Actions → General) and then in the repository, enable “Allow GitHub Actions to create and approve pull requests”.

### First publish of a new package

Trusted publishing (OIDC) can only publish a package that already exists on npm: it cannot create one. A new package (for example `@uncage/runtime-acp` in 0.3) must be published once by hand before the release workflow can publish it: `pnpm build`, then `pnpm --filter @uncage/runtime-acp publish --access public --no-git-checks` while logged in with `npm login`. Then configure its trusted publisher (above). Until then the release publishes the other packages and fails on the new one, which leaves a release with a missing dependency.

If that GitHub setting cannot be enabled, the workflow cannot open the version pull request. Version locally instead:

```sh
pnpm changeset version     # bumps versions, updates changelogs, consumes changesets
git commit -am "chore: version packages" && git push   # via a normal pull request into main
```

When that commit lands on `main` there are no pending changesets and the versions are unpublished, so the workflow publishes them directly.

## This help site

The site lives in `apps/docs` (Astro + Starlight). It is not part of the root `pnpm build`, `pnpm typecheck` or `pnpm lint` (Astro needs Node.js 22.23.4 or newer; the packages support 22.0+), so it has its own CI job.

```sh
pnpm build                          # the packages (the API reference and the sample check use them)
pnpm --filter docs dev              # http://localhost:4321/docs/
pnpm --filter docs check            # sample type-check + full build with link validation
```

- **Pages** are markdown files in `apps/docs/src/content/docs/` (English) and `apps/docs/src/content/docs/zh-cn/` and `.../ja/` (Chinese and Japanese; every page except the API reference, the changelog and this one). The sidebar order is in `apps/docs/src/nav.mjs`; `/llms.txt` and `/llms-full.txt` follow it.
- **Code samples:** every code block fenced as `ts` or `tsx` is type-checked by `apps/docs/scripts/check-snippets.ts` against the workspace packages. Blocks on one page form one project; give a block `title="lib/tools.ts"` to make it a file others can import. Add the word `nocheck` to the fence (a `ts nocheck` info string) only for fragments that are not a whole file (a signature, one option).
- **Links** to other pages are absolute and include the base: `/docs/guides/define-tools/`. The build fails on a broken internal link or anchor (`starlight-links-validator`).
- **API reference** (`/api/…`) is generated at build time from the packages’ TypeScript (TypeDoc + `typedoc-plugin-markdown`, via `starlight-typedoc`); improve it by improving the TSDoc comments in the source.
- **For agents:** every page is also served as `/<page>.md`; `/llms.txt`, `/llms-full.txt` and `/skills/uncage/SKILL.md` are generated from the pages and from `skills/uncage/SKILL.md` at the repository root.
- **Deploy:** the site and the help site are one static Vercel deployment (`vercel.json`, `node scripts/build-web.mjs`, output `apps/site/dist`), published at `https://uncage-dev.vercel.app/docs/`. `.github/workflows/docs.yml` (the **Web** check) builds it, validates the links and checks the translations on every pull request and push to `main`; it deploys nothing. The live demo is hosted separately (see `docs/deploy-web.md` in the repository).

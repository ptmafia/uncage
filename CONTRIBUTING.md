# Contributing

## Development

```sh
pnpm install
pnpm build && pnpm typecheck && pnpm lint && pnpm test
pnpm e2e:mock   # Playwright against a mock daemon; uses your system Chrome locally
```

In CI, `CI=true` makes Playwright use its bundled Chromium instead of system Chrome.
`pnpm e2e:live` talks to a real Claude Code and is never run in CI.

## Releasing

Releases are automatic, driven by [Changesets](https://github.com/changesets/changesets).
All public `@uncage/*` packages share one version (`fixed` group).

1. In every PR with a user-visible change run `pnpm changeset`, choose the bump, write a
   short note, and commit the generated `.changeset/*.md` file.
2. When the PR merges to `main`, `.github/workflows/release.yml` opens (or updates) a
   "chore: version packages" PR that bumps versions and writes changelogs.
3. Merging that PR makes the same workflow run `changeset publish`, which publishes every
   unpublished version to npm with provenance and tags the release.

Publishing uses npm trusted publishing (OIDC). There is no `NPM_TOKEN` secret.

### One-time setup

**npm, per public package** (`@uncage/protocol`, `core`, `server`, `client`, `react`,
`react-ui`, `runtime-claude`, `runtime-codex`, `cli`, `hub`, and `agent` once it exists):
npmjs.com, package, Settings, Trusted publishing, GitHub Actions:

- Organization or user: `ptmafia`
- Repository: `uncage`
- Workflow filename: `release.yml`
- Environment: leave empty

A package that has never been published (new in 0.2: `@uncage/hub`, `@uncage/agent`) has no
settings page yet. Either publish it once by hand (`pnpm build`, then
`pnpm --filter @uncage/hub publish --access public --no-git-checks` while logged in with
`npm login`) and configure the trusted publisher afterwards, or create it with the first
release using a temporary granular access token (write access, bypass 2FA) exposed to the
workflow as `NODE_AUTH_TOKEN`, then configure trusted publishing and delete the token.

**GitHub:** in the organization (Settings, Actions, General) and then the repository, enable
"Allow GitHub Actions to create and approve pull requests". Org settings override the repo.

### Without the Version PR permission

If that setting cannot be enabled, the workflow fails when creating the Version PR and
publishes nothing. Version locally instead:

```sh
pnpm changeset version     # bumps versions, updates changelogs, consumes changesets
git commit -am "chore: version packages" && git push   # via a normal PR into main
```

When that commit lands on `main` there are no pending changesets and the versions are
unpublished, so the workflow publishes them directly.

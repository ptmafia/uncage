# @uncage/agent

The Connected Mode daemon on the user's machine. It dials out to one or more website hubs
(`@uncage/hub`) over WebSocket and runs the sessions those sites start through `@uncage/core`
with the user's own Claude Code. You normally don't install it directly: users install
`@uncage/cli` (the site's `install.sh`, or `npm i -g @uncage/cli`) and run `uncage setup <site-url>`,
which uses this package.

```ts
import { createAgent } from '@uncage/agent';
```

- Per-site data dir `~/.uncage/sites/<siteId>/`, per-session workspace `~/Uncage/<siteHost>/<sessionId>/`.
- Local policy in `~/.uncage/agent.yaml`: bypass permissions only with `localPolicy.allowBypass: true`, optional `allowedPermissionModes`; machine tokens stored with mode 0600.
- Replicates events to the hub with backfill after reconnects; redacted local activity log (`uncage activity`).

Docs: https://uncage-dev.vercel.app/docs/

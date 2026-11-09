---
"@uncage/hub": patch
---

Next.js (Turbopack and webpack) apps that import `@uncage/hub` from a page, route handler or Server Action no longer fail with "Can't resolve 'ioredis'" (or `pg`) when those optional packages are not installed: the hub's dynamic imports of its optional peers carry `webpackIgnore`, and the build checks it.

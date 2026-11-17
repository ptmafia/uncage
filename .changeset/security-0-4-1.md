---
'@uncage/agent': patch
'@uncage/cli': patch
'@uncage/client': patch
'@uncage/core': patch
'@uncage/hub': patch
'@uncage/protocol': patch
'@uncage/react': patch
'@uncage/react-ui': patch
'@uncage/runtime-acp': patch
'@uncage/runtime-claude': patch
'@uncage/runtime-codex': patch
'@uncage/server': patch
---

Security fixes.

- **Device-approval phishing (high).** Anyone could run `uncage setup` against a site on their own computer and send a user the `/device?code=` link; approving it linked the sender's computer to the user's account. The hub now stores the requesting client IP (store migration 10) and `lookupDevice` / `GET /device/lookup` return `requestedAt` and `requestIp`. `<ApproveDevice>` and `useDeviceApproval` treat a code from a link as untrusted by default (`source: 'link'`): they warn, show the request time and IP, hide the code's last 4 characters and enable Approve only after the user typed them. Pass `source: 'typed'` only for a code the user typed. Deny stays one click.
- **Push notifications leaked conversation content (medium).** `expoPushNotifier` / `defaultPushMessage` now send generic text ("An approval needs you", "A run finished", "A run failed") plus the deep-link data. Session and approval titles (often shell commands or paths) are included only with `includeContent: true`.

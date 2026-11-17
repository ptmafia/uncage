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

**Behaviour change, check before upgrading:** `<ApproveDevice>` and `useDeviceApproval` now treat every code as coming from a link unless you pass `source: 'typed'`. For such a code, Approve stays disabled (and `approve()` does nothing, with one `console.warn`) until the user typed the code's last 4 characters. If you render your own approve screen with `useDeviceApproval`, show the warning, the request time and IP, and an input wired to `confirmation.setTyped`, or Approve will never work. Pass `source: 'typed'` only for a code the user typed on your page, never based on the URL.

- **Device-approval phishing (high).** Anyone could run `uncage setup` against a site on their own computer and send a user the `/device?code=` link; approving it linked the sender's computer to the user's account. The hub now stores the requesting client IP (store migration 10; `null` when the hub has no trusted client IP) and `lookupDevice` / `GET /device/lookup` return `requestedAt` and `requestIp`. The approve UI warns, shows the request time and the IP as seen by the server, labels the name and OS as reported by the computer, hides the code's last 4 characters (masked from the compacted code) and enables Approve only after the user typed them. A link code that is not exactly `ABCD-EFGH` / `ABCDEFGH` is refused as "not a valid link" without a lookup. The hub drops a reported computer name or OS that contains the code's last 4 characters and strips control characters from both. Deny stays one click.
- **Push notifications leaked conversation content (medium).** `expoPushNotifier` / `defaultPushMessage` now send generic text ("An approval needs you", "A run finished", "A run failed") plus the deep-link data. Session and approval titles (often shell commands or paths) are included only with `includeContent: true`.

---
'@uncage/react-ui': patch
---

`<ApproveDevice>`: when the code lookup itself failed (`lookup: null` plus `error`, e.g. `rate_limited` after too many unknown codes), the page shows the localized error instead of "This code is invalid or has expired".

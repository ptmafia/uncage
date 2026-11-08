# @uncage/client

## 0.2.0

- Local Mode fixes: protocol types are re-exported and browser validation uses a lightweight structural guard instead of zod (smaller bundle).
- `client.machines()`, `installInfo()`, `revokeMachine()` and `createSession({ machineId })`. Note: `UncageClient` gains three required methods; custom client implementations must add them.

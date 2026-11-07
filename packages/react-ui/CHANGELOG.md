# @uncage/react-ui

## 0.2.0

- `<AgentChat>` restores the last active session on reload.
- New `<ConnectMachine>`, `<ApproveDevice>` and `<MachineStatus>`; `<AgentChat>` shows the computer picker, the connect flow when no computer is connected, and a disabled composer while the computer is offline.
- `<ApproveDevice>` shows a failed code lookup's localized error (e.g. rate limited) instead of "invalid or expired".

---
'@uncage/protocol': minor
'@uncage/hub': minor
'@uncage/client': minor
'@uncage/react': minor
'@uncage/react-ui': minor
---

Connected Mode in the browser: `client.machines()` / `installInfo()` / `revokeMachine()` and
`createSession({ machineId })`; `useMachines()` (auto-detects a hub; a local daemon's 404 keeps
Local Mode unchanged); `<ConnectMachine>`, `<ApproveDevice>` and `<MachineStatus>`, and
`<AgentChat>` shows the computer picker, the connect flow when no computer is connected and a
disabled composer while the computer is offline. `Session.machineId` (optional): the hub stamps
every session it returns with the computer it runs on. Note: `UncageClient` gains three required
methods; custom client implementations must add them.

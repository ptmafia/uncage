# @uncage/protocol

## 0.2.0

- Connected Mode wire protocol (version 1): hub/agent frames, device login, tool manifests, file and attachment frames, `Session.machineId` (optional).
- `createSession` args take an optional hub-chosen `id`; `startRun` args take optional `warnings` (`RunWarningSchema`, at most `MAX_RUN_WARNINGS`).

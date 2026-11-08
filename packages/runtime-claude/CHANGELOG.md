# @uncage/runtime-claude

## 0.2.0

- Hardening for site-injected tools and skills: schema complexity guard, destructive-action confirmation tools, `.claude` symlink fence, built-in tool name collisions rejected.
- Site skills can never run shell on the machine: inline `` !`cmd` `` and ```` ```! ```` blocks in hub skill markdown (SKILL.md and `.md` skill files) are neutralized, and runs carrying site skills set Claude Code's `disableSkillShellExecution`.

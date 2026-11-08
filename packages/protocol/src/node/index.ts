/** Node-only helpers (`@uncage/protocol/node`). The package root stays free of `node:` imports. */
export { materializeSkills, type MaterializedSkill } from './skills.js';
export {
  cmdLine,
  findCommand,
  isCmdLine,
  parseNpmCmdShim,
  resolveCommand,
  systemCmd,
  UnsafeCommandError,
  type ResolvedCommand,
  type ResolveOptions,
} from './exe.js';

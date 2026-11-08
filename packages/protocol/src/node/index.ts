/**
 * Node-only helpers (`@uncage/protocol/node`) for runtime adapters: skill materialization and
 * shell-free command resolution (Windows npm shims included). The package root stays free of
 * `node:` imports.
 *
 * @module node
 */
export { materializeSkills, type MaterializedSkill } from './skills.js';
export {
  cmdLine,
  findCommand,
  isCmdLine,
  parseNpmCmdShim,
  isSystemTool,
  resolveCommand,
  safeExecFile,
  systemCmd,
  systemTool,
  type SystemToolName,
  UnsafeCommandError,
  type ResolvedCommand,
  type ResolveOptions,
} from './exe.js';

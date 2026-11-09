/** The one-command installers a site's users run (served by the hub at /api/uncage/install.{sh,ps1}). */
export const INSTALL_COMMANDS = [
  { os: 'sh', label: 'macOS / Linux', prompt: '$', cmd: 'curl -fsSL https://your.site/api/uncage/install.sh | bash' },
  { os: 'ps', label: 'Windows', prompt: 'PS>', cmd: 'irm https://your.site/api/uncage/install.ps1 | iex' },
] as const;

export type InstallOs = (typeof INSTALL_COMMANDS)[number]['os'];

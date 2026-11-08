import { UPLOAD_FAILED_REASON } from '@uncage/react';
import { ATTACHMENT_LIMITS, type EffortLevel, type ErrorCode, type PermissionMode, type RuntimeStatus } from '@uncage/protocol';

export type Locale = 'en' | 'zh-CN';

const pad2 = (n: number) => String(n).padStart(2, '0');

/** Local wall-clock time as HH:mm. */
export function formatClock(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/**
 * File size for chips: `512 B`, `1.2 KB`, `3.4 MB`. With `whole`, a whole number drops its
 * decimal (`10 MB`, for limits).
 */
export function formatBytes(n: number, o: { whole?: boolean } = {}): string {
  const fmt = (v: number) => (o.whole && Number.isInteger(v) ? String(v) : v.toFixed(1));
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${fmt(n / 1024)} KB`;
  return `${fmt(n / (1024 * 1024))} MB`;
}

/** Ends a server message with punctuation so copy can follow it. */
const sentence = (s: string) => (/[.!?。！？]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`);

const en = {
  // Shell
  sessions: 'Sessions',
  newSession: 'New session',
  noSessions: 'No sessions yet',
  sessionListLabel: 'Session list',
  readOnlyTag: 'Read-only',
  ago: (ms: number) => {
    const m = Math.floor(ms / 60_000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
  },
  // Runtime
  runtimeLabel: 'Runtime',
  runtimeStatus: {
    available: 'Ready',
    not_installed: 'Not installed',
    auth_required: 'Sign-in needed',
    incompatible: 'Incompatible version',
    error: 'Error',
  } satisfies Record<RuntimeStatus, string>,
  installGuide: 'Install guide',
  noRuntimes: 'No runtimes found. Start the Uncage daemon and reload.',
  runtimeUnavailable: (name: string) => `${name} isn't available right now.`,
  // Empty state
  startWith: (name: string) => `Start a session with ${name}`,
  starterPrompts: 'Try asking',
  // Messages
  messagesLabel: 'Conversation',
  thinking: 'Thinking…',
  elapsed: (ms: number) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${pad2(s % 60)}s`;
  },
  // Tool steps
  steps: (n: number, time: string) => `${n} ${n === 1 ? 'step' : 'steps'} · ${time}`,
  stepRunning: 'Running',
  stepWaiting: 'Waiting for you',
  stepDone: 'Done',
  stepFailed: 'Failed',
  stepDeclined: 'You declined',
  // Approval
  approvalTitle: (title: string) => `Needs your OK: ${title}`,
  inDir: (cwd: string) => `in ${cwd}`,
  details: 'Details',
  expiresAt: (iso: string) => `Expires at ${formatClock(iso)} — nothing runs if you don't respond`,
  deny: 'Deny',
  allowOnce: 'Allow once',
  approved: 'Allowed',
  denied: (title: string) => `Denied — ${title}`,
  expired: 'Approval expired',
  cancelled: 'Cancelled',
  approvalFailed: "Your decision didn't go through",
  // Composer
  composerLabel: 'Message',
  placeholder: (name: string, canAttach: boolean) => (canAttach ? `Message ${name}, attach files…` : `Message ${name}…`),
  send: 'Send',
  stop: 'Stop',
  readOnlyHint: "This session can't be continued. Its history is still available.",
  runActive: 'A run is in progress',
  // Composer settings
  labelled: (title: string, value: string) => `${title}: ${value}`,
  modelTitle: 'Model',
  effortTitle: 'Effort',
  permissionTitle: 'Permissions',
  defaultOption: 'Default',
  appliesNextRun: 'Applies to the next run',
  efforts: {
    low: 'Low',
    medium: 'Medium',
    high: 'High',
    xhigh: 'Extra high',
    max: 'Max',
  } satisfies Record<EffortLevel, string>,
  effortHints: {
    low: 'Fastest, least thinking',
    medium: 'Balanced',
    high: 'Thinks harder',
    xhigh: 'Thinks much harder',
    max: 'Deepest thinking, slowest',
  } satisfies Record<EffortLevel, string>,
  permissionModes: {
    default: 'Ask every time',
    acceptEdits: 'Accept edits',
    plan: 'Plan mode',
    auto: 'Auto mode',
    bypassPermissions: 'Bypass permissions',
  } satisfies Record<PermissionMode, string>,
  permissionHints: {
    default: 'Asks before running commands or editing files',
    acceptEdits: 'Edits files without asking; asks before commands',
    plan: 'Plans and explains first; changes nothing',
    auto: 'The runtime decides what needs your OK',
    bypassPermissions: 'Runs anything without asking',
  } satisfies Record<PermissionMode, string>,
  bypassConfirm: 'Agent will run any command without asking. Continue?',
  cancel: 'Cancel',
  enable: 'Enable',
  bypassBanner: 'Bypass permissions is on: the agent runs any command without asking.',
  settingReset: 'A setting was reset: the runtime no longer offers it',
  // Attachments
  attach: 'Attach files',
  removeAttachment: (name: string) => `Remove ${name}`,
  attachmentsLabel: 'Attachments',
  uploading: 'Uploading',
  uploadFailed: 'Upload failed',
  dropToAttach: 'Drop files to attach',
  rejectedType: (name: string) => `Unsupported file type: ${name}`,
  rejectedSize: (name: string, max: string) => `File too large (max ${max}): ${name}`,
  rejectedCount: (name: string, max: number) => `At most ${max} attachments per message: ${name}`,
  openImage: (name: string) => `Open ${name} in a new tab`,
  // Voice
  micStart: 'Voice input',
  micStop: 'Stop voice input',
  speechNotice: "Audio is processed by your browser vendor's speech service.",
  micError: (code: string) =>
    code === 'not-allowed' || code === 'service-not-allowed'
      ? 'Microphone access was blocked. Allow it in the browser to dictate.'
      : code === 'no-speech'
        ? 'No speech was detected.'
        : `Voice input stopped (${code}).`,
  // Running sessions
  runningCount: (n: number) => `${n} running`,
  runningSessions: 'Running sessions',
  waitingState: 'Waiting for you',
  // Run status
  running: 'Running',
  queued: 'Starting',
  waitingForYou: (n: number) => `${n} waiting for you`,
  runDone: (time: string) => `Done · ${time}`,
  runInterrupted: 'Interrupted — the runtime stopped. Send again to retry.',
  runFailed: (msg: string) => (msg ? `Failed — ${sentence(msg)} Send again to retry.` : 'Failed. Send again to retry.'),
  runCancelled: 'Stopped — you cancelled this run.',
  // Connection
  reconnecting: 'Reconnecting… new output will appear when the connection is back.',
  offline: 'Offline — updates are paused. Reload the page to reconnect.',
  replayIncomplete: 'Some earlier events are no longer available, so this history may be incomplete.',
  dismiss: 'Dismiss',
  // Connected mode: computers.
  // Terminology: the background process on the user's computer (`uncage agent`) is "the agent" in
  // English and "守护进程" in Chinese, everywhere. The computer itself is "computer" / "电脑".
  connectTitle: 'Connect your computer',
  connectSubtitle: 'Run one command on the computer you want to connect. It shows up here as soon as the agent is online.',
  connectOneCommand: 'Run this command on your computer',
  connectOneCommandNote:
    'It checks the computer and asks before installing anything it needs (Node.js 22, the Uncage CLI). Then it opens a browser to sign in and keeps the agent running in the background.',
  connectAlreadyInstalled: 'Already have the CLI?',
  osTabs: 'Operating system',
  osUnix: 'macOS / Linux',
  osWindows: 'Windows',
  comingSoon: 'Coming soon',
  copy: 'Copy',
  copied: 'Copied',
  copyFailed: 'Copy failed — select the text',
  copyCommand: (cmd: string) => `Copy command: ${cmd}`,
  loadingCommands: 'Loading commands…',
  waitingForComputer: 'Waiting for your computer…',
  computerConnected: (name: string) => `Connected: ${name}`,
  noBrowserTitle: "That computer can't open a browser?",
  noBrowserBody:
    'Run this instead. It prints a link and a code: open the link on any device where you are signed in to this site, then confirm the code.',
  retry: 'Retry',
  done: 'Done',
  machineLabel: 'Computer',
  machinePicker: 'Choose a computer',
  machineOnline: 'Online',
  machineOffline: (ago: string) => `Offline · seen ${ago}`,
  machineStatus: (name: string, online: boolean) => `Computer: ${name} (${online ? 'online' : 'offline'})`,
  machineAgentOutdated: 'Agent update needed',
  /** The hub refused this computer's agent as too old (`MachineInfo.agentOutdated`). Backticks mark commands. */
  agentOutdated: (setup: string) =>
    `This computer's Uncage agent is too old for this website. On that computer run \`npm i -g @uncage/cli@latest\`, then \`${setup}\`.`,
  connectAnother: 'Connect another computer…',
  osName: (os: string) =>
    ({ darwin: 'macOS', linux: 'Linux', win32: 'Windows' } as Record<string, string>)[os] ?? os,
  computerOffline: 'Your computer is offline. Waiting for it to reconnect…',
  computerOfflineHint: 'On that computer, run',
  noComputer: 'Connect your computer to start.',
  // Device approval page
  approveTitle: 'Connect this computer?',
  approveBody: (name: string, os: string) => `${name}${os ? ` (${os})` : ''} wants to connect to your account.`,
  approveWhat: 'Once connected, sessions you start on this site run on that computer.',
  approveCode: 'Code',
  approveMatch: 'Make sure this code matches the one shown in the terminal.',
  approveRepairs: (name: string) => `This reconnects ${name}. Its previous connection will stop working.`,
  approve: 'Approve',
  unnamedComputer: 'An unnamed computer',
  approvedDone: 'Computer connected. You can close this page and go back to the terminal.',
  deniedDone: 'Denied. Nothing was connected.',
  deviceNotFound: 'This code is invalid or has expired. Run `uncage setup` again to get a new one.',
  deviceExpired: 'This code has expired. Run `uncage setup` again to get a new one.',
  // Errors (by `UncageClientError.code`; unknown codes show the server message)
  errors: {
    attachment_type_unsupported: 'This file type is not supported.',
    unsupported_capability: "The runtime doesn't support this feature or option.",
    policy_denied: "The server's policy doesn't allow this.",
    session_read_only: "This session is read-only and can't be continued. Start a new session.",
    invalid_workspace: 'The workspace is outside the allowed folders.',
    runtime_unavailable: "The runtime isn't available.",
    auth_required: 'The runtime needs you to sign in.',
    session_busy: 'This session is busy with a run. Wait for it to finish or stop it, then send again.',
    approval_expired: 'This approval has expired.',
    approval_already_resolved: 'This approval was already handled.',
    internal_error: 'Something went wrong on the server. Try again in a moment.',
    machine_offline: 'Your computer is offline. Make sure the agent (`uncage agent`) is running on it.',
    machine_not_found: 'No computer is connected yet. Connect your computer first.',
    rate_limited: 'Too many requests. Wait a moment and try again.',
    device_code_expired: 'This code has expired. Run `uncage setup` again to get a new one.',
    upgrade_required: 'The Uncage agent on your computer is too old. Update it with `npm i -g @uncage/cli`.',
  } satisfies Partial<Record<ErrorCode, string>>,
  attachmentTooLarge: (max: string) => `The attachment is too large (max ${max} each).`,
  attachmentUploadFailed: (name: string) => `Attachment "${name}" failed to upload. Remove it to send.`,
  uploadFailedReason: (name: string, reason: string) => `${name} failed to upload: ${reason}`,
  authRequiredNamed: (name: string) => `${name} needs you to sign in.`,
  daemonUnreachable: "The Uncage service isn't running. Start it with `uncage serve`.",
  serverUnreachable: "Can't reach the server. Check that the app is still running, then retry.",
  httpFailed: (status: number) => `Can't reach the server (HTTP ${status}).`,
  unsupportedWhat: (what: string) => `The runtime doesn't support ${what}.`,
  capability: {
    model: (v: string) => `the model "${v}"`,
    effort: (label: string) => `the "${label}" effort`,
    permissionMode: (label: string) => `the "${label}" permission mode`,
    scope: (v: string) => `the approval scope "${v}"`,
    image: 'image attachments',
    file: 'file attachments',
  },
};

export type Strings = typeof en;

const zhCN: Strings = {
  sessions: '会话',
  newSession: '新建会话',
  noSessions: '还没有会话',
  sessionListLabel: '会话列表',
  readOnlyTag: '只读',
  ago: (ms: number) => {
    const m = Math.floor(ms / 60_000);
    if (m < 1) return '刚刚';
    if (m < 60) return `${m} 分钟前`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h} 小时前`;
    return `${Math.floor(h / 24)} 天前`;
  },
  runtimeLabel: '运行时',
  runtimeStatus: {
    available: '可用',
    not_installed: '未安装',
    auth_required: '需要登录',
    incompatible: '版本不兼容',
    error: '出错了',
  },
  installGuide: '安装说明',
  noRuntimes: '没有找到运行时。启动 Uncage 守护进程后刷新页面。',
  runtimeUnavailable: (name: string) => `${name} 现在用不了。`,
  startWith: (name: string) => `和 ${name} 开始会话`,
  starterPrompts: '可以这样问',
  messagesLabel: '对话',
  thinking: '正在思考…',
  elapsed: (ms: number) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    return s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${pad2(s % 60)} 秒`;
  },
  steps: (n: number, time: string) => `${n} 步 · ${time}`,
  stepRunning: '进行中',
  stepWaiting: '等你确认',
  stepDone: '完成',
  stepFailed: '没成功',
  stepDeclined: '你拒绝了',
  approvalTitle: (title: string) => `需要你确认：${title}`,
  inDir: (cwd: string) => `目录：${cwd}`,
  details: '查看详情',
  expiresAt: (iso: string) => `${formatClock(iso)} 前没处理会过期，不执行`,
  deny: '拒绝',
  allowOnce: '允许执行',
  approved: '已允许',
  denied: (title: string) => `没继续：你拒绝了「${title}」`,
  expired: '确认已过期',
  cancelled: '已取消',
  approvalFailed: '你的决定没能提交',
  composerLabel: '消息',
  placeholder: (name: string, canAttach: boolean) => (canAttach ? `给 ${name} 发消息，可添加附件…` : `给 ${name} 发消息…`),
  send: '发送',
  stop: '停止',
  readOnlyHint: '这个会话无法继续了，历史仍可查看。',
  runActive: '正在运行',
  labelled: (title: string, value: string) => `${title}：${value}`,
  modelTitle: '模型',
  effortTitle: '推理强度',
  permissionTitle: '权限',
  defaultOption: '默认',
  appliesNextRun: '下一次运行生效',
  efforts: {
    low: '低',
    medium: '中',
    high: '高',
    xhigh: '超高',
    max: '最高',
  },
  effortHints: {
    low: '最快，思考最少',
    medium: '均衡',
    high: '想得更深',
    xhigh: '想得更深入',
    max: '思考最深，最慢',
  },
  permissionModes: {
    default: '每次询问',
    acceptEdits: '自动接受编辑',
    plan: '计划模式',
    auto: '自动模式',
    bypassPermissions: '完全放行',
  },
  permissionHints: {
    default: '执行命令或修改文件前都先问你',
    acceptEdits: '直接修改文件，执行命令前先问你',
    plan: '先规划和说明，不做任何改动',
    auto: '由运行时判断哪些操作需要你确认',
    bypassPermissions: '不经询问执行任何操作',
  },
  bypassConfirm: 'Agent 将不经询问执行任何命令，确定开启？',
  cancel: '取消',
  enable: '开启',
  bypassBanner: '已开启完全放行：Agent 会不经询问执行任何命令。',
  settingReset: '某项设置已重置：运行时不再提供该选项',
  attach: '添加附件',
  removeAttachment: (name: string) => `移除 ${name}`,
  attachmentsLabel: '附件',
  uploading: '上传中',
  uploadFailed: '上传失败',
  dropToAttach: '松开以添加附件',
  rejectedType: (name: string) => `不支持的文件类型：${name}`,
  rejectedSize: (name: string, max: string) => `文件太大（上限 ${max}）：${name}`,
  rejectedCount: (name: string, max: number) => `每条消息最多 ${max} 个附件：${name}`,
  openImage: (name: string) => `在新标签页打开 ${name}`,
  micStart: '语音输入',
  micStop: '停止语音输入',
  speechNotice: '语音由浏览器厂商的语音服务处理。',
  micError: (code: string) =>
    code === 'not-allowed' || code === 'service-not-allowed'
      ? '麦克风权限被拦截了，请在浏览器里允许后再试。'
      : code === 'no-speech'
        ? '没有听到声音。'
        : `语音输入已停止（${code}）。`,
  runningCount: (n: number) => `${n} 个运行中`,
  runningSessions: '运行中的会话',
  waitingState: '等你处理',
  running: '运行中',
  queued: '正在启动',
  waitingForYou: (n: number) => `${n} 项等你处理`,
  runDone: (time: string) => `完成 · 用时 ${time}`,
  runInterrupted: '已中断：运行时停止了。可以重新发送。',
  runFailed: (msg: string) => (msg ? `没成功：${sentence(msg)} 可以重新发送。` : '没成功。可以重新发送。'),
  runCancelled: '已停止：你取消了这次运行。',
  reconnecting: '正在重新连接… 连上后会继续显示新的输出。',
  offline: '连接断开了，更新暂停。刷新页面重新连接。',
  replayIncomplete: '部分较早的事件已经不在了，这段历史可能不完整。',
  dismiss: '关闭',
  connectTitle: '连接你的电脑',
  connectSubtitle: '在要连接的电脑上运行一条命令。守护进程一上线，这里就会自动识别。',
  connectOneCommand: '在你的电脑上运行这条命令',
  connectOneCommandNote: '它会先检查这台电脑，安装所需的东西（Node.js 22、Uncage CLI）之前都会先征求你的同意；然后打开浏览器登录，并在后台保持守护进程运行。',
  connectAlreadyInstalled: '已经装好 CLI？',
  osTabs: '操作系统',
  osUnix: 'macOS / Linux',
  osWindows: 'Windows',
  comingSoon: '即将支持',
  copy: '复制',
  copied: '已复制',
  copyFailed: '复制失败，请手动选择文本',
  copyCommand: (cmd: string) => `复制命令：${cmd}`,
  loadingCommands: '正在获取命令…',
  waitingForComputer: '等待你的电脑上线…',
  computerConnected: (name: string) => `已连接：${name}`,
  noBrowserTitle: '那台电脑打不开浏览器？',
  noBrowserBody: '改用下面这条命令。它会打印一个链接和一个验证码：在任意已登录本网站的设备上打开链接，确认验证码即可。',
  retry: '重试',
  done: '完成',
  machineLabel: '电脑',
  machinePicker: '选择电脑',
  machineOnline: '在线',
  machineOffline: (ago: string) => `离线 · ${ago}在线`,
  machineStatus: (name: string, online: boolean) => `电脑：${name}（${online ? '在线' : '离线'}）`,
  machineAgentOutdated: '需要更新守护进程',
  agentOutdated: (setup: string) =>
    `这台电脑上的 Uncage 守护进程版本过旧。请在那台电脑上运行 \`npm i -g @uncage/cli@latest\`，然后运行 \`${setup}\` 重新连接。`,
  connectAnother: '连接另一台电脑…',
  osName: (os: string) =>
    ({ darwin: 'macOS', linux: 'Linux', win32: 'Windows' } as Record<string, string>)[os] ?? os,
  computerOffline: '你的电脑离线了，等待重新连接…',
  computerOfflineHint: '在那台电脑上运行',
  noComputer: '先连接你的电脑再开始。',
  approveTitle: '连接这台电脑？',
  approveBody: (name: string, os: string) => `${name}${os ? `（${os}）` : ''}请求连接到你的账号。`,
  approveWhat: '连接后，你在本网站发起的会话会在那台电脑上运行。',
  approveCode: '验证码',
  approveMatch: '请确认这串验证码和终端里显示的一致。',
  approveRepairs: (name: string) => `这会重新连接「${name}」，它之前的连接将失效。`,
  approve: '批准',
  unnamedComputer: '一台未命名的电脑',
  approvedDone: '电脑已连接。可以关闭此页面，回到终端。',
  deniedDone: '已拒绝，没有连接任何电脑。',
  deviceNotFound: '验证码无效或已过期。重新运行 `uncage setup` 获取新的验证码。',
  deviceExpired: '验证码已过期。重新运行 `uncage setup` 获取新的验证码。',
  errors: {
    attachment_type_unsupported: '不支持这种文件类型。',
    unsupported_capability: '当前运行时不支持这个功能或选项。',
    policy_denied: '服务器策略不允许这个操作。',
    session_read_only: '这个会话是只读的，无法继续。请新建一个会话。',
    invalid_workspace: '工作目录不在允许的范围内。',
    runtime_unavailable: '运行时现在用不了。',
    auth_required: '运行时需要登录。',
    session_busy: '这个会话正在运行，等它结束或先停止，再发送。',
    approval_expired: '这个确认已过期。',
    approval_already_resolved: '这个确认已经处理过了。',
    internal_error: '服务出错了，请稍后重试。',
    machine_offline: '你的电脑离线了。请确认那台电脑上的守护进程（`uncage agent`）正在运行。',
    machine_not_found: '还没有连接电脑，先连接你的电脑。',
    rate_limited: '请求太频繁了，稍等一下再试。',
    device_code_expired: '验证码已过期。重新运行 `uncage setup` 获取新的验证码。',
    upgrade_required: '你电脑上的 Uncage 守护进程版本太旧，请用 `npm i -g @uncage/cli` 更新。',
  },
  attachmentTooLarge: (max: string) => `附件太大了（单个上限 ${max}）。`,
  attachmentUploadFailed: (name: string) => `附件「${name}」上传失败，移除后再发送。`,
  uploadFailedReason: (name: string, reason: string) => `「${name}」上传失败：${reason}`,
  authRequiredNamed: (name: string) => `${name} 需要登录。`,
  daemonUnreachable: 'Uncage 服务没有运行，先在终端执行 `uncage serve`。',
  serverUnreachable: '连不上服务器，请确认应用仍在运行后重试。',
  httpFailed: (status: number) => `连不上服务器（HTTP ${status}）。`,
  unsupportedWhat: (what: string) => `当前运行时不支持${what}。`,
  capability: {
    model: (v: string) => `模型「${v}」`,
    effort: (label: string) => `推理强度「${label}」`,
    permissionMode: (label: string) => `权限模式「${label}」`,
    scope: (v: string) => `确认范围「${v}」`,
    image: '图片附件',
    file: '文件附件',
  },
};

export const STRINGS: Record<Locale, Strings> = { en, 'zh-CN': zhCN };

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

/** What an `unsupported_capability` error refused, from its details (core and store set one key). */
function capabilityWhat(t: Strings, d: Record<string, unknown>): string | undefined {
  const model = str(d.model);
  if (model) return t.capability.model(model);
  const effort = str(d.effort);
  if (effort) return t.capability.effort(Object.hasOwn(t.efforts, effort) ? t.efforts[effort as EffortLevel] : effort);
  const mode = str(d.permissionMode);
  if (mode) {
    return t.capability.permissionMode(Object.hasOwn(t.permissionModes, mode) ? t.permissionModes[mode as PermissionMode] : mode);
  }
  const scope = str(d.scope);
  if (scope) return t.capability.scope(scope);
  if (d.kind === 'image' || d.kind === 'file') return t.capability[d.kind];
  return undefined;
}

/**
 * The user-facing text for an error: a localized message for known codes, the proxy's
 * daemon-unreachable errors, client-side transport failures and the store's upload-failed send
 * error; otherwise the server's message and hint as sent. The server's hint is dropped (it is
 * English) except for `runtime_unavailable` / `auth_required`, where it carries the install or
 * login command. `nameOf` turns `details.runtime` (an id) into a display name.
 */
export function errorText(
  t: Strings,
  err: { code: ErrorCode; message: string; hint?: string; details?: Record<string, unknown> },
  nameOf: (runtimeId: string) => string = (id) => id,
): { message: string; hint?: string } {
  const details = err.details ?? {};
  if (details.reason === UPLOAD_FAILED_REASON && typeof details.name === 'string') {
    return { message: t.attachmentUploadFailed(details.name) };
  }
  if (details.reason === 'daemon_unreachable') return { message: t.daemonUnreachable };
  if (err.code === 'internal_error' && details.reason === 'network') return { message: t.serverUnreachable };
  if (err.code === 'internal_error' && details.reason === 'http_status' && typeof details.status === 'number') {
    return { message: t.httpFailed(details.status) };
  }
  const withHint = (message: string) => ({ message, ...(err.hint ? { hint: err.hint } : {}) });
  const runtime = str(details.runtime);
  if (err.code === 'runtime_unavailable') {
    return withHint(runtime ? t.runtimeUnavailable(nameOf(runtime)) : t.errors.runtime_unavailable);
  }
  if (err.code === 'auth_required') return withHint(runtime ? t.authRequiredNamed(nameOf(runtime)) : t.errors.auth_required);
  if (err.code === 'unsupported_capability') {
    const what = capabilityWhat(t, details);
    return { message: what ? t.unsupportedWhat(what) : t.errors.unsupported_capability };
  }
  if (err.code === 'attachment_too_large') {
    const max = typeof details.maxBytes === 'number' && details.maxBytes > 0 ? details.maxBytes : ATTACHMENT_LIMITS.maxBytes;
    return { message: t.attachmentTooLarge(formatBytes(max, { whole: true })) };
  }
  const known = (t.errors as Partial<Record<ErrorCode, string>>)[err.code];
  if (known) return { message: known };
  return { message: err.message, ...(err.hint ? { hint: err.hint } : {}) };
}

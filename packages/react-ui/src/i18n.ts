import type { EffortLevel, PermissionMode, RuntimeStatus } from '@uncage/protocol';

export type Locale = 'en' | 'zh-CN';

const pad2 = (n: number) => String(n).padStart(2, '0');

/** Local wall-clock time as HH:mm. */
export function formatClock(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** File size for chips: `512 B`, `1.2 KB`, `3.4 MB`. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
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
};

export const STRINGS: Record<Locale, Strings> = { en, 'zh-CN': zhCN };

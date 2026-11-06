import type { RuntimeStatus } from '@uncage/protocol';

export type Locale = 'en' | 'zh-CN';

const pad2 = (n: number) => String(n).padStart(2, '0');

/** Local wall-clock time as HH:mm. */
export function formatClock(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
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
  placeholder: (name: string) => `Ask ${name}…`,
  send: 'Send',
  stop: 'Stop',
  readOnlyHint: "This session can't be continued. Its history is still available.",
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
  placeholder: (name: string) => `问 ${name}…`,
  send: '发送',
  stop: '停止',
  readOnlyHint: '这个会话无法继续了，历史仍可查看。',
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

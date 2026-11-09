import type { DialogLocale } from '../confirm-dialog.js';

/** Every string the page shows, per locale. `{x}` placeholders are filled in by the page script. */
const STRINGS = {
  en: {
    title: 'Uncage dashboard',
    heading: 'Connected websites',
    lead: 'Websites this computer is connected to, and what they did here. Only you can open this page; it closes after 30 minutes without use.',
    agent: 'Background agent',
    agentRunning: 'running',
    agentStopped: 'not running',
    agentInstalled: 'installed',
    agentNotInstalled: 'not installed (run: uncage agent install)',
    agentNone: 'no background service (foreground agent)',
    online: 'Online',
    offline: 'Offline',
    revoked: 'Revoked',
    ws: 'WebSocket',
    http: 'HTTP streaming',
    machine: 'Machine',
    since: 'Connected since',
    unknown: 'unknown',
    offered: 'Agents offered',
    activity: 'Recent activity',
    noActivity: 'No activity yet.',
    disconnect: 'Disconnect',
    disconnecting: 'Disconnecting…',
    confirmDisconnect: 'Disconnect {name} ({domain})?\n\nThis revokes this computer on the website and removes its token here. Local session data and workspaces are kept.',
    empty: 'No connected websites. Connect one with: uncage setup <url>',
    runtimesHeading: 'Agents on this computer',
    runtimesLead: 'The coding agents this computer offers to every connected website.',
    enable: 'Enable',
    disable: 'Disable',
    confirmEnable: 'Enable {name}?\n\nUncage will run it whenever the agent starts. Agents distributed through npx/uvx are downloaded and run.',
    builtin: 'Built in',
    enabled: 'Enabled',
    disabled: 'Disabled',
    auto: 'When installed',
    configured: 'Configured',
    policy: 'Local policy',
    bypass: 'Bypass permissions',
    allowed: 'Allowed',
    notAllowed: 'Not allowed',
    modes: 'Permission modes',
    anyMode: 'Any',
    policyHint: 'Change it in ~/.uncage/agent.yaml (localPolicy). Websites can never change it.',
    error: 'Something went wrong',
    closed: 'The dashboard has stopped. Run uncage dashboard to open it again.',
  },
  zh: {
    title: 'Uncage 控制台',
    heading: '已连接的网站',
    lead: '这台电脑已连接的网站，以及它们在这里做了什么。只有你能打开此页面；30 分钟无操作后自动关闭。',
    agent: '后台代理',
    agentRunning: '运行中',
    agentStopped: '未运行',
    agentInstalled: '已安装',
    agentNotInstalled: '未安装（运行：uncage agent install）',
    agentNone: '没有后台服务（前台运行的代理）',
    online: '在线',
    offline: '离线',
    revoked: '已撤销',
    ws: 'WebSocket',
    http: 'HTTP 流式',
    machine: '电脑 ID',
    since: '连接时间',
    unknown: '未知',
    offered: '提供的智能体',
    activity: '最近活动',
    noActivity: '暂无活动。',
    disconnect: '断开连接',
    disconnecting: '正在断开…',
    confirmDisconnect: '断开与 {name}（{domain}）的连接？\n\n这会在该网站上撤销这台电脑，并删除本机保存的令牌。本地会话数据和工作区会保留。',
    empty: '还没有连接任何网站。使用 uncage setup <url> 连接一个。',
    runtimesHeading: '这台电脑上的智能体',
    runtimesLead: '这台电脑向所有已连接网站提供的编码智能体。',
    enable: '启用',
    disable: '停用',
    confirmEnable: '启用 {name}？\n\n每次代理启动时 Uncage 都会运行它。通过 npx/uvx 分发的智能体会被下载并运行。',
    builtin: '内置',
    enabled: '已启用',
    disabled: '已停用',
    auto: '安装后可用',
    configured: '已配置',
    policy: '本地策略',
    bypass: '跳过权限确认',
    allowed: '允许',
    notAllowed: '不允许',
    modes: '权限模式',
    anyMode: '任意',
    policyHint: '在 ~/.uncage/agent.yaml（localPolicy）中修改。网站永远无法修改它。',
    error: '出错了',
    closed: '控制台已停止。运行 uncage dashboard 重新打开。',
  },
  ja: {
    title: 'Uncage ダッシュボード',
    heading: '接続済みのサイト',
    lead: 'このコンピューターが接続しているサイトと、そこで行われたこと。このページを開けるのはあなただけです。30 分間操作がないと閉じます。',
    agent: 'バックグラウンドエージェント',
    agentRunning: '実行中',
    agentStopped: '停止中',
    agentInstalled: 'インストール済み',
    agentNotInstalled: '未インストール（実行: uncage agent install）',
    agentNone: 'バックグラウンドサービスなし（フォアグラウンドのエージェント）',
    online: 'オンライン',
    offline: 'オフライン',
    revoked: '取り消し済み',
    ws: 'WebSocket',
    http: 'HTTP ストリーミング',
    machine: 'マシン ID',
    since: '接続日時',
    unknown: '不明',
    offered: '提供中のエージェント',
    activity: '最近のアクティビティ',
    noActivity: 'アクティビティはまだありません。',
    disconnect: '接続を解除',
    disconnecting: '解除しています…',
    confirmDisconnect: '{name}（{domain}）との接続を解除しますか？\n\nサイト上でこのコンピューターを取り消し、ここに保存されたトークンを削除します。ローカルのセッションデータとワークスペースは残ります。',
    empty: '接続済みのサイトはありません。uncage setup <url> で接続できます。',
    runtimesHeading: 'このコンピューターのエージェント',
    runtimesLead: 'このコンピューターが接続済みのすべてのサイトに提供するコーディングエージェント。',
    enable: '有効にする',
    disable: '無効にする',
    confirmEnable: '{name} を有効にしますか？\n\nエージェントが起動するたびに Uncage がこれを実行します。npx/uvx で配布されるエージェントはダウンロードして実行されます。',
    builtin: '組み込み',
    enabled: '有効',
    disabled: '無効',
    auto: 'インストール時',
    configured: '設定済み',
    policy: 'ローカルポリシー',
    bypass: '権限確認のスキップ',
    allowed: '許可',
    notAllowed: '不許可',
    modes: '権限モード',
    anyMode: 'すべて',
    policyHint: '~/.uncage/agent.yaml（localPolicy）で変更します。サイトから変更されることはありません。',
    error: 'エラーが発生しました',
    closed: 'ダッシュボードは停止しました。uncage dashboard で再度開けます。',
  },
} satisfies Record<DialogLocale, Record<string, string>>;

export type DashboardStrings = (typeof STRINGS)['en'];

export const HTML_LANG: Record<DialogLocale, string> = { en: 'en', zh: 'zh-CN', ja: 'ja' };

export function dashboardStrings(locale: DialogLocale): DashboardStrings {
  return STRINGS[locale];
}

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
/** JSON safe inside a <script> element. */
const scriptJson = (v: unknown): string => JSON.stringify(v).replace(/</g, '\\u003c');

/** Uncage / Kumi look: warm paper, ink text, ink primary buttons, brand blue only for focus. */
const CSS = `
:root{--canvas:#faf8f4;--surface:#fff;--surface-2:#f3efe7;--border:#e2dccf;--border-soft:#ebe5da;--ink:#2b2926;--ink-2:#5f5a52;--ink-3:#736b60;--ink-hover:#403d39;--accent:#3b5bdb;--ring:rgb(59 91 219/.16);--ok-bg:#e9f1ea;--ok-fg:#2f6b3f;--warn-bg:#fbf1e1;--warn-fg:#94621a;--err-bg:#fbece8;--err-fg:#a33a2a;--err-border:#f0d3cc;--neutral-bg:#eeeae2;--neutral-fg:#6d665c;
--sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,system-ui,"PingFang SC","Hiragino Sans","Microsoft YaHei",sans-serif;--serif:Georgia,"Times New Roman","Songti SC","Noto Serif SC",serif;--mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace}
@media (prefers-color-scheme:dark){:root{--canvas:#1f1e1c;--surface:#272523;--surface-2:#2f2d2a;--border:#3d3a36;--border-soft:#35322e;--ink:#ece8e1;--ink-2:#c3bdb3;--ink-3:#a39c91;--ink-hover:#d9d4cc;--accent:#8ea2ff;--ring:rgb(142 162 255/.22);--ok-bg:#25352a;--ok-fg:#9fd0ab;--warn-bg:#3a3122;--warn-fg:#e3bf7f;--err-bg:#3d2723;--err-fg:#f0a597;--err-border:#5a3630;--neutral-bg:#33302c;--neutral-fg:#b9b2a7}}
*{box-sizing:border-box}
body{margin:0;background:var(--canvas);color:var(--ink);font:14px/24px var(--sans)}
main{max-width:880px;margin:0 auto;padding:40px 24px 64px}
header{display:flex;align-items:baseline;justify-content:space-between;gap:16px;flex-wrap:wrap}
.brand{font:600 13px/20px var(--sans);letter-spacing:.02em;color:var(--ink-3);text-transform:uppercase}
h1{font:400 28px/36px var(--serif);margin:6px 0 4px}
h2{font:600 15px/22px var(--sans);margin:36px 0 4px}
.lead{color:var(--ink-2);margin:0 0 20px;max-width:640px}
.agent{font-size:13px;color:var(--ink-2)}
.card{background:var(--surface);border:1px solid var(--border-soft);border-radius:12px;padding:18px 20px;margin:12px 0}
.row{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.name{font:600 15px/22px var(--sans)}
.domain{font-family:var(--mono);font-size:13px;color:var(--ink-2)}
.pill{display:inline-block;font-size:12px;line-height:18px;padding:1px 8px;border-radius:999px;background:var(--neutral-bg);color:var(--neutral-fg);white-space:nowrap}
.pill.online,.pill.enabled{background:var(--ok-bg);color:var(--ok-fg)}
.pill.revoked,.pill.disabled{background:var(--err-bg);color:var(--err-fg)}
dl{display:grid;grid-template-columns:max-content 1fr;gap:2px 16px;margin:12px 0 0;font-size:13px}
#policy dl{margin-top:0}
dt{color:var(--ink-3)}dd{margin:0;word-break:break-all}
details{margin-top:10px;font-size:13px}summary{cursor:pointer;color:var(--ink-2)}
ol.activity{list-style:none;margin:8px 0 0;padding:0;font-family:var(--mono);font-size:12px;line-height:18px;color:var(--ink-2);max-height:260px;overflow:auto}
ol.activity li{padding:2px 0;border-top:1px solid var(--border-soft)}
.fail{color:var(--err-fg)}
button{font:500 13px/20px var(--sans);border-radius:8px;padding:5px 12px;cursor:pointer;border:1px solid var(--border);background:var(--surface);color:var(--ink)}
button:hover{background:var(--surface-2)}
button:focus-visible{outline:none;box-shadow:0 0 0 3px var(--ring);border-color:var(--accent)}
button.primary{background:var(--ink);color:var(--canvas);border-color:var(--ink)}button.primary:hover{background:var(--ink-hover)}
button.danger{color:var(--err-fg);border-color:var(--err-border)}button.danger:hover{background:var(--err-bg)}
button:disabled{opacity:.55;cursor:default}
table{width:100%;border-collapse:collapse;font-size:13px}
td{padding:8px 4px;border-top:1px solid var(--border-soft)}td:last-child{text-align:right}
tr:first-child td{border-top:0}
.muted{color:var(--ink-3);font-size:13px}
#notice{white-space:pre-wrap;font-size:13px;border-radius:10px;padding:10px 14px;margin:12px 0;background:var(--surface-2);color:var(--ink-2)}
#notice.err{background:var(--err-bg);color:var(--err-fg)}
#notice[hidden]{display:none}
`;

/**
 * The page script: renders `/api/sites` with DOM APIs (text only, never HTML), refreshes it, and
 * posts actions with the session cookie. Says goodbye when the tab closes so the server can exit.
 */
const SCRIPT = `
const T = JSON.parse(document.getElementById('strings').textContent);
const LANG = document.documentElement.lang;
const $ = (s) => document.querySelector(s);
const el = (tag, attrs, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (v !== undefined && v !== null) e.setAttribute(k, v);
  }
  for (const k of kids) if (k !== null && k !== undefined) e.append(k);
  return e;
};
const fill = (s, vars) => s.replace(/\\{(\\w+)\\}/g, (_, k) => vars[k] ?? '');
const when = (iso) => { try { return new Date(iso).toLocaleString(LANG); } catch { return iso; } };
let busy = false;

function notice(lines, isErr) {
  const n = $('#notice');
  n.textContent = Array.isArray(lines) ? lines.join('\\n') : lines;
  n.className = isErr ? 'err' : '';
  n.hidden = false;
}

async function post(path) {
  const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body.error && body.error.message) || T.error + ' (HTTP ' + res.status + ')');
  return body;
}

function agentLine(a) {
  if (a.kind === 'none') return T.agentNone;
  if (!a.installed) return T.agentNotInstalled;
  return a.running === true ? T.agentRunning : a.running === false ? T.agentStopped : T.agentInstalled;
}

function activityLine(e) {
  const status = e.ok === undefined ? '' : e.ok ? ' ok' : ' failed' + (e.code ? ' (' + e.code + ')' : '');
  const detail = e.detail === undefined ? '' : ' ' + JSON.stringify(e.detail);
  return el('li', { class: e.ok === false ? 'fail' : '' }, when(e.at) + '  ' + e.kind + (e.name ? ' ' + e.name : '') + status + detail);
}

function siteCard(s, runtimes) {
  const names = s.runtimes.map((id) => (runtimes.find((r) => r.id === id) || { name: id }).name).join(', ');
  const state = el('span', { class: 'pill ' + s.state, 'data-testid': 'site-state' }, T[s.state] + (s.state === 'online' && s.transport ? ' · ' + (T[s.transport] || s.transport) : ''));
  const btn = el('button', { class: 'danger', type: 'button', onclick: async () => {
    if (!confirm(fill(T.confirmDisconnect, { name: s.name, domain: s.domain }))) return;
    btn.disabled = true; btn.textContent = T.disconnecting; busy = true;
    try { notice((await post('/api/sites/' + encodeURIComponent(s.id) + '/disconnect')).messages); }
    catch (e) { notice(e.message, true); }
    finally { busy = false; await load(); }
  } }, T.disconnect);
  return el('article', { class: 'card site', 'data-site': s.id, 'aria-label': s.name },
    el('div', { class: 'row' },
      el('div', {}, el('div', { class: 'name' }, s.name), el('div', { class: 'domain' }, s.domain + (s.origin.replace(/^https?:\\/\\//, '') !== s.domain ? '  ·  ' + s.origin : ''))),
      el('div', { class: 'row' }, state, btn)),
    el('dl', {},
      el('dt', {}, T.machine), el('dd', {}, s.machineId),
      el('dt', {}, T.since), el('dd', {}, s.connectedAt ? when(s.connectedAt) : T.unknown),
      el('dt', {}, T.offered), el('dd', {}, names)),
    el('details', {}, el('summary', {}, T.activity + ' (' + s.activity.length + ')'),
      s.activity.length ? el('ol', { class: 'activity' }, ...s.activity.map(activityLine)) : el('p', { class: 'muted' }, T.noActivity)));
}

function runtimeRow(r) {
  const btn = r.toggle ? el('button', { type: 'button', class: r.state === 'disabled' ? 'primary' : '', onclick: async () => {
    const next = r.state === 'disabled' ? 'enable' : 'disable';
    if (next === 'enable' && !confirm(fill(T.confirmEnable, { name: r.name }))) return;
    btn.disabled = true; busy = true;
    try { notice((await post('/api/runtimes/' + encodeURIComponent(r.id) + '/' + next)).messages); }
    catch (e) { notice(e.message, true); }
    finally { busy = false; await load(); }
  } }, r.state === 'disabled' ? T.enable : T.disable) : null;
  return el('tr', { 'data-runtime': r.id }, el('td', {}, r.name), el('td', {}, el('span', { class: 'pill ' + r.state }, T[r.state] || r.state)), el('td', {}, btn));
}

function render(d) {
  $('#agent').textContent = T.agent + ': ' + agentLine(d.agent);
  const sites = $('#sites');
  sites.replaceChildren(...(d.sites.length ? d.sites.map((s) => siteCard(s, d.runtimes)) : [el('p', { class: 'card muted' }, T.empty)]));
  $('#runtimes').replaceChildren(el('table', {}, el('tbody', {}, ...d.runtimes.map(runtimeRow))));
  const modes = d.policy.allowedPermissionModes;
  $('#policy').replaceChildren(el('dl', {},
    el('dt', {}, T.bypass), el('dd', {}, d.policy.allowBypass ? T.allowed : T.notAllowed),
    el('dt', {}, T.modes), el('dd', {}, modes && modes.length ? modes.join(', ') : T.anyMode)), el('p', { class: 'muted' }, T.policyHint));
}

async function load() {
  try {
    const res = await fetch('/api/sites');
    if (!res.ok) throw new Error(T.error + ' (HTTP ' + res.status + ')');
    render(await res.json());
  } catch (e) {
    notice(T.closed, true);
    clearInterval(timer);
  }
}
const timer = setInterval(() => { if (!busy && document.visibilityState === 'visible') void load(); }, 5000);
addEventListener('pagehide', () => navigator.sendBeacon('/api/bye'));
void load();
`;

/** The dashboard page: static markup, strings as JSON, the script under the request's CSP nonce. */
export function dashboardPage(locale: DialogLocale, nonce: string): string {
  const t = STRINGS[locale];
  return `<!doctype html>
<html lang="${HTML_LANG[locale]}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<link rel="icon" href="data:,">
<title>${esc(t.title)}</title>
<style nonce="${nonce}">${CSS}</style>
</head>
<body>
<main>
<header><div><div class="brand">Uncage</div><h1>${esc(t.heading)}</h1></div><div class="agent" id="agent"></div></header>
<p class="lead">${esc(t.lead)}</p>
<div id="notice" role="status" hidden></div>
<section id="sites" aria-label="${esc(t.heading)}"></section>
<h2>${esc(t.runtimesHeading)}</h2>
<p class="lead">${esc(t.runtimesLead)}</p>
<section class="card" id="runtimes" aria-label="${esc(t.runtimesHeading)}"></section>
<h2>${esc(t.policy)}</h2>
<section class="card" id="policy" aria-label="${esc(t.policy)}"></section>
</main>
<script type="application/json" id="strings">${scriptJson(t)}</script>
<script nonce="${nonce}">${SCRIPT}</script>
</body>
</html>`;
}

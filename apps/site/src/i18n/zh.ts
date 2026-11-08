import type { Dict } from './schema.ts';

/**
 * Simplified Chinese (zh-CN) homepage copy. Native marketing copy written against the English
 * (en.ts), with the same claims. Terminology follows apps/docs/i18n-glossary.md; the approval
 * buttons match the real UI (packages/react-ui/src/i18n.ts: 允许执行 / 拒绝).
 * Spacing: a half-width space between Chinese and Latin words, as on the zh-cn help site.
 */
export const pending = false;

export const zh: Dict = {
  meta: {
    title: 'Uncage：你的 coding agent，无处不在',
    description:
      'Uncage 让你的网站驱动每位用户在自己电脑上运行的 Claude Code：实时流式输出、审批、网站工具与技能，结果直接回到你的网站。开源，MIT 许可。',
    ogAlt: 'Uncage。你的 coding agent，无处不在。本地 harness，即服务。',
  },
  tagline: '本地 harness，即服务。',
  a11y: {
    skip: '跳到正文',
    home: 'Uncage 首页',
    mainNav: '主导航',
    menu: '菜单',
    language: '语言',
    copy: '复制',
    copied: '已复制',
    external: '在新标签页打开',
  },
  nav: {
    product: '产品',
    how: '工作原理',
    security: '安全',
    docs: '文档',
    demo: '演示',
    tryDemo: '体验演示',
  },
  langHint: {
    text: '本页面也提供简体中文版。',
    switch: '切换到简体中文',
    dismiss: '关闭',
  },
  hero: {
    eyebrow: 'v0.2 · Connected 模式已上线',
    title: '你的 coding agent，|*无处不在。*',
    lede: '你的用户手里早就有一套强大的环境：他们自己的 Claude Code、自己的账号、自己的工具。Uncage 把这套本地 harness 变成你的产品可以调用的服务。任务在用户的电脑上运行，结果回到你的网站上。',
    primary: '体验在线演示',
    secondary: '几分钟完成接入',
    installLabel: '用户只需运行一次',
  },
  flow: {
    label: '一次请求的流向：你网站上的对话，由用户电脑主动建立的 WebSocket 连接，以及在这台电脑上运行的 Claude Code。',
    browserTitle: 'your.site',
    online: '电脑在线',
    userMessage: '为这次发布做一个落地页并上线',
    toolNote: '在你的服务器上运行',
    assistant: '页面已写好。要发布到你的网站吗？',
    allow: '允许执行',
    deny: '拒绝',
    wire: 'WebSocket，由用户电脑主动发起',
    termSkill: '已加载技能',
    termWrite: '已写入',
    termWaiting: '等待审批…',
  },
  why: {
    kicker: '为什么选 Uncage',
    title: '不必在云端重建用户的环境。',
    titleLine2: '连上他们已有的那一套。',
    sub: '云端 agent 沙箱从零开始，每个 token 都由你买单。Uncage 不借用、也不托管任何东西：它让你的产品驱动用户本来就信任的那个 agent。',
    sandbox: {
      title: '托管式 agent 沙箱',
      points: ['一个空环境，每次运行都要重建', '用户的凭据和代码由你保管', '算力和每一次模型调用都由你付费', '数据链路上又多了一家供应商'],
    },
    uncage: {
      title: 'Uncage：用户自己的 harness',
      points: [
        '他们自己的 Claude Code、配置、MCP 服务器和代码仓库',
        '用他们自己的账号登录，不与你共享，也不由你保存',
        '你这边的模型成本为零',
        '除非你的工具主动读取，文件始终留在用户的电脑上',
      ],
    },
  },
  how: {
    kicker: '工作原理',
    title: '三个组件，一套协议。',
    sub: '浏览器只和你的网站通信；你的网站通过用户电脑自己建立的连接，和这台电脑通信。除此之外，别无其他。',
    steps: [
      {
        tag: '连接',
        title: '用户连接自己的电脑',
        body: '一条命令，再在浏览器里授权一次。后台的守护进程主动连向你的网站，无需开放任何端口。',
      },
      {
        tag: '指令',
        title: '由你的网站下达指令',
        body: '你产品里的对话发起运行，实时展示每一步，并弹出“允许执行 / 拒绝”审批卡片。',
      },
      {
        tag: '交付',
        title: '结果回到你的网站',
        body: 'Claude Code 调用你的工具和技能，处理函数以当前登录用户的身份在你的后端运行。',
      },
    ],
  },
  features: {
    kicker: '功能',
    title: '连接你的产品与用户的 agent，所需的一切。',
    sub: '开源的构建模块。直接用默认 UI，或者用 hooks 打造完全自定义的界面。',
    availableLabel: '现已可用',
    soonLabel: '即将推出',
    soonBadge: '即将推出',
    available: [
      {
        title: '实时流式输出与审批',
        body: '每个 token、每个工具步骤都实时推送到你的界面。有风险的操作会等待“允许执行 / 拒绝”卡片确认。',
      },
      {
        title: '网站工具',
        body: '用 zod schema 声明一项能力。Claude Code 看到的是一个 MCP 工具，处理函数在你的服务器上运行。',
      },
      {
        title: '技能',
        body: '把团队规范和模板写成 Markdown 下发。每次运行时加载，绝不会被当作代码执行。',
      },
      {
        title: '存储由你决定',
        body: '历史记录可以留在用户的电脑上，也可以同步到你的网站，会话结束后依然保留。',
      },
      {
        title: '开箱即用的 React UI',
        body: 'Claude Code 风格的输入框，支持选择模型、推理强度和权限模式，还有附件与语音输入。',
      },
      {
        title: '横向扩展',
        body: '借助 Postgres 和 Redis 适配器，hub 可以在任意负载均衡器之后多节点运行。',
      },
    ],
    soon: [
      {
        title: 'Codex 实机验证',
        body: 'Codex 适配器现已发布，并已通过模拟服务器测试。下一步是在真实的可执行文件上完成验证。',
      },
      {
        title: 'Windows 与 Linux 守护进程',
        body: '目前后台守护进程运行在 macOS 上。',
      },
      {
        title: '更多入口',
        body: '移动应用、聊天应用和浏览器扩展，驱动同一套本地 harness。',
      },
      {
        title: '适配 Serverless 的传输层',
        body: '把 hub 部署在 Vercel 或 Netlify 上。目前 WebSocket 仍需要一个长期运行的 Node 进程。',
      },
    ],
  },
  code: {
    kicker: '面向开发者',
    title: '挂载 hub，放入对话框。',
    sub: '你的认证、你的数据库、你的 Node 服务器。Uncage 直接接入你现有的技术栈。',
    moreTitle: '从零到连上一台电脑',
    moreBody: '快速入门会一步步带你搭建一个 Next.js 应用，包含 hub、设备授权页面和你的第一个网站工具。Express、Fastify 和 Hono 同样适用。',
    more: '查看 Connected 模式快速入门',
  },
  security: {
    kicker: '安全',
    title: '自己的电脑，用户说了算。',
    sub: '你的网站只发送数据，从不发送代码。最终决定权永远在本地。',
    points: [
      {
        title: '只传数据，不传代码',
        body: 'hub 只发送工具 schema、技能文本和一组固定的命令。网页端没有任何 shell 通道。',
      },
      {
        title: '只用用户自己的账号',
        body: '每台电脑运行的都是其主人自己的 Claude Code。没有共享密钥。',
      },
      {
        title: '本地策略优先',
        body: '绕过权限只能在用户电脑上的配置文件里开启。',
      },
      {
        title: '活动日志',
        body: '{activity} 会列出每个网站请求过什么。',
      },
    ],
    more: '了解信任模型',
  },
  final: {
    title: '让用户的 agent 在你的产品里开工。',
    sub: 'MIT 许可 · npm 上的 11 个包 · 为开发者和 coding agent 打造',
    primary: '体验在线演示',
    secondary: '阅读文档',
  },
  footer: {
    product: '产品',
    developers: '开发者',
    project: '项目',
    features: '功能',
    quickstart: '快速入门',
    api: 'API 参考',
    forAgents: '面向 coding agent',
    changelog: '更新日志',
    license: 'MIT 许可证',
    rights: '基于 MIT 许可证发布。',
  },
  notFound: {
    title: '页面不存在',
    body: '你要找的页面不存在，或者已经移动。',
    home: '返回首页',
    docs: '打开文档',
  },
};

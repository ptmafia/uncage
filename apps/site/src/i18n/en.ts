import type { Dict } from './schema.ts';

export const en: Dict = {
  meta: {
    title: 'Uncage: run your coding agent everywhere',
    description:
      'Uncage lets your website drive each user’s own Claude Code on their own computer: live streaming, approvals, site tools and skills, with the results landing on your site. Open source, MIT.',
    ogAlt: 'Uncage. Run your coding agent everywhere. Local harness, as a service.',
  },
  tagline: 'Local harness, as a service.',
  a11y: {
    skip: 'Skip to content',
    home: 'Uncage home',
    mainNav: 'Main',
    menu: 'Menu',
    language: 'Language',
    copy: 'Copy',
    copied: 'Copied',
    external: 'opens in a new tab',
    installOs: 'Operating system',
  },
  nav: {
    product: 'Product',
    how: 'How it works',
    security: 'Security',
    docs: 'Docs',
    demo: 'Demo',
    tryDemo: 'Try the demo',
  },
  langHint: {
    text: 'This page is also available in English.',
    switch: 'Read it in English',
    dismiss: 'Dismiss',
  },
  hero: {
    eyebrow: 'v0.2 · Connected Mode is live',
    title: 'Run your coding agent *everywhere.*',
    lede: 'Your users already have a powerful setup: their own Claude Code, their logins, their tools. Uncage turns that local harness into a service your product can call. The work runs on their machine; the results land on your site.',
    primary: 'Try the live demo',
    secondary: 'Integrate in minutes',
    installLabel: 'One command, one approval',
  },
  flow: {
    label: 'How a request flows: a chat on your site, a WebSocket or HTTPS stream opened by the user’s computer, and Claude Code running there.',
    browserTitle: 'your.site',
    online: 'Machine online',
    userMessage: 'Build a landing page for our launch and publish it',
    toolNote: 'runs on your server',
    assistant: 'Page written. Publish it to your site?',
    allow: 'Allow once',
    deny: 'Deny',
    wire: 'WebSocket or HTTPS streaming, dialed out by the user’s machine',
    termSkill: 'loaded skill',
    termWrite: 'wrote',
    termWaiting: 'waiting for approval…',
  },
  why: {
    kicker: 'Why Uncage',
    title: 'Don’t rebuild their environment in the cloud.',
    titleLine2: 'Connect to the one they already have.',
    sub: 'Cloud agent sandboxes start from zero and bill you for every token. Uncage borrows nothing and hosts nothing: it lets your product drive the agent your user already trusts.',
    sandbox: {
      title: 'Hosted agent sandbox',
      points: [
        'An empty environment, rebuilt for every run',
        'You hold your users’ credentials and code',
        'You pay for the compute and every model call',
        'One more vendor in the data path',
      ],
    },
    uncage: {
      title: 'Uncage: the user’s own harness',
      points: [
        'Their Claude Code, configs, MCP servers and repos',
        'Their own login, never shared with you or stored by you',
        'Zero model cost on your side',
        'Your site sees only what the conversation shows and what your tools pull',
      ],
    },
  },
  how: {
    kicker: 'How it works',
    title: 'Three moving parts. One protocol.',
    sub: 'The browser talks to your site. Your site talks to the user’s machine over a WebSocket or HTTPS stream the machine opened itself. Nothing else.',
    steps: [
      {
        tag: 'Connect',
        title: 'The user links their computer',
        body: 'One command, one approval in the browser. A background agent dials out to your site, so no ports are opened.',
      },
      {
        tag: 'Instruct',
        title: 'Your site gives the instructions',
        body: 'A chat in your product starts runs, streams every step and shows Allow / Deny cards.',
      },
      {
        tag: 'Deliver',
        title: 'Results land on your site',
        body: 'Claude Code calls your tools and skills. The handlers run in your backend, as the signed-in user.',
      },
    ],
  },
  features: {
    kicker: 'Features',
    title: 'Everything between your product and their agent.',
    sub: 'Open-source building blocks. Use the default UI, or go headless with hooks.',
    availableLabel: 'Available today',
    soonLabel: 'Coming soon',
    soonBadge: 'Coming soon',
    available: [
      {
        title: 'Live streaming and approvals',
        body: 'Every token and tool step streams to your UI. Risky actions wait for an Allow / Deny card.',
      },
      {
        title: 'Site tools',
        body: 'Declare a capability with a zod schema. Claude Code sees an MCP tool; the handler runs on your server.',
      },
      {
        title: 'Skills',
        body: 'Ship your house rules and templates as markdown. They are loaded for each run, never run as code.',
      },
      {
        title: 'Your storage choice',
        body: 'Keep history on the user’s machine, or replicate it to your site so it outlives the session.',
      },
      {
        title: 'Drop-in React UI',
        body: 'A Claude Code-style composer with models, effort, permission modes, attachments and voice input.',
      },
      {
        title: 'Runs anywhere',
        body: 'A long-running Node server, Vercel, Cloudflare Workers or any Fetch platform. FaaS mode needs only Postgres; add Redis to scale out.',
      },
      {
        title: 'Any ACP agent',
        body: 'Claude Code through its ACP adapter (verified live), and any agent that speaks the Agent Client Protocol, such as Gemini CLI or OpenCode, shows up in the runtime picker.',
      },
      {
        title: 'macOS, Windows and Linux',
        body: 'One command installs everything on macOS, Windows or Linux. The agent runs as a per-user background service: no sudo on macOS and Linux, a per-user install on Windows. macOS is verified on real devices; Windows and Linux are CI verified, real-device confirmation pending.',
      },
    ],
    soon: [
      {
        title: 'Codex, verified',
        body: 'The Codex adapter ships today, tested against a simulated server. Verification on the real binary is next.',
      },
      {
        title: 'More entry points',
        body: 'Mobile apps, chat apps and browser extensions driving the same local harness.',
      },
    ],
  },
  code: {
    kicker: 'For developers',
    title: 'Mount a hub. Drop in a chat.',
    sub: 'Your auth, your database, your server or functions platform. Uncage plugs into what you run today.',
    moreTitle: 'From zero to a connected computer',
    moreBody: 'The quickstart builds a Next.js app with the hub, the device approval page and your first site tool, step by step. Express, Fastify and Hono work too.',
    more: 'Follow the Connected Mode quickstart',
  },
  security: {
    kicker: 'Security',
    title: 'The user stays in charge of their machine.',
    sub: 'Your website sends data, never code. The final say is always local.',
    points: [
      {
        title: 'Data, not code',
        body: 'The hub sends tool schemas, skill text and a fixed set of commands. There is no shell from the web.',
      },
      {
        title: 'Their own login only',
        body: 'Every machine runs its owner’s Claude Code. No shared keys.',
      },
      {
        title: 'Local policy wins',
        body: 'Bypassing permissions can only be turned on in a file on the user’s computer.',
      },
      {
        title: 'Activity log',
        body: '{activity} shows what every site asked for.',
      },
    ],
    more: 'Read the trust model',
  },
  final: {
    title: 'Put your users’ agents to work in your product.',
    sub: 'MIT licensed · 11 packages on npm · built for developers and coding agents',
    primary: 'Try the live demo',
    secondary: 'Read the docs',
  },
  footer: {
    product: 'Product',
    developers: 'Developers',
    project: 'Project',
    features: 'Features',
    quickstart: 'Quickstart',
    api: 'API reference',
    forAgents: 'For coding agents',
    changelog: 'Changelog',
    license: 'MIT License',
    rights: 'Released under the MIT License.',
  },
  notFound: {
    title: 'Page not found',
    body: 'The page you are looking for does not exist or has moved.',
    home: 'Back to the homepage',
    docs: 'Open the docs',
  },
};

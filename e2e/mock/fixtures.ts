import { expect, test as base, type Locator, type Page } from '@playwright/test';

export type Example = 'default' | 'headless';

/** The two examples share copy (zh-CN) and roles; only their class names differ. */
const SELECTORS: Record<
  Example,
  { ready: string; userBubble: string; assistant: string; runStatus: string; approvalCard: string; approvalLine: string; toolDone: string }
> = {
  default: {
    ready: '.uc-runtime[data-checked]',
    userBubble: '.uc-user-bubble',
    assistant: '.uc-assistant',
    runStatus: '.uc-runstatus',
    approvalCard: 'section.uc-approval',
    approvalLine: '.uc-approval-line',
    toolDone: '.uc-steps[data-state="completed"]',
  },
  headless: {
    ready: '.chat header >> text=Claude Code',
    userBubble: '.msg-user',
    assistant: '.msg-assistant',
    runStatus: '.run-status',
    approvalCard: '.approval-card',
    approvalLine: '.approval-line',
    toolDone: '.tool[data-status="completed"]',
  },
};

export const CONTROL_URL = 'http://127.0.0.1:4794';

export interface Chat {
  page: Page;
  input: Locator;
  userBubbles: Locator;
  assistant: Locator;
  runStatus: Locator;
  approvalCard: Locator;
  approvalLine: Locator;
  toolDone: Locator;
  allow: Locator;
  deny: Locator;
  stop: Locator;
  /** Error toasts inside the app (Next's own route announcer is also `role=alert`). */
  alert: Locator;
  /** Opens the empty chat and waits until the runtime list has loaded, so the first send counts. */
  open(): Promise<void>;
  send(prompt: string): Promise<void>;
  expectRunState(state: string, opts?: { timeout?: number }): Promise<void>;
  /** Waits until the page has put the active session into `?session=` and returns the URL. */
  sessionUrl(): Promise<string>;
}

export function chatFor(page: Page, example: Example): Chat {
  const s = SELECTORS[example];
  const input = page.getByRole('textbox', { name: '消息' });
  const runStatus = page.locator(s.runStatus);
  return {
    page,
    input,
    userBubbles: page.locator(s.userBubble),
    assistant: page.locator(s.assistant),
    runStatus,
    approvalCard: page.locator(s.approvalCard),
    approvalLine: page.locator(s.approvalLine),
    toolDone: page.locator(s.toolDone),
    allow: page.getByRole('button', { name: '允许执行' }),
    deny: page.getByRole('button', { name: '拒绝', exact: true }),
    stop: page.getByRole('button', { name: '停止' }),
    alert: page.getByRole('main').getByRole('alert'),
    async open() {
      await page.goto('/');
      await expect(page.locator(s.ready)).toBeVisible();
    },
    async send(prompt) {
      await input.fill(prompt);
      await input.press('Enter');
    },
    async expectRunState(state, opts) {
      await expect(runStatus).toHaveAttribute('data-state', state, opts);
    },
    async sessionUrl() {
      await expect(page).toHaveURL(/[?&]session=/);
      return page.url();
    },
  };
}

/** Set per project in playwright.config.ts. */
export interface ExampleOptions {
  example: Example;
}

export const test = base.extend<ExampleOptions & { chat: Chat }>({
  example: ['default', { option: true }],
  chat: async ({ page, example }, use) => {
    await use(chatFor(page, example));
  },
});

export { expect };

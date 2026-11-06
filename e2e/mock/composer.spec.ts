/**
 * Composer controls against the mock daemon, whose fake "Claude Code" advertises models, efforts,
 * every permission mode and image + file attachments, and whose `echo` prompt replies with what the
 * run received (`settings: model=… effort=… mode=…; attachments: …`). So these specs prove each
 * control reaches the runtime, not only that the UI changes.
 */
import { readFileSync } from 'node:fs';
import { PORTS } from '../playwright.config.ts';
import { chatFor, expect, menuLabels, pickMenu, test } from './fixtures.ts';

const IMAGE = { name: 'uncage-42.png', mimeType: 'image/png', buffer: readFileSync(new URL('../fixtures/uncage-42.png', import.meta.url)) };
const NOTES = { name: 'notes.md', mimeType: 'text/markdown', buffer: Buffer.from('# Notes\n\nthe secret word is marmalade\n') };
const echoed = (s: string) => `settings: ${s}`;
// Runs receive their attachments in pick (attachmentIds) order, whichever upload finished first.
const BOTH = String.raw`uncage-42\.png,notes\.md`;

/** Cancels runs other specs may have left active, so the running count starts from 0. */
async function cancelActiveRuns(): Promise<void> {
  const daemon = `http://127.0.0.1:${PORTS.daemon}`;
  const headers = { authorization: 'Bearer test-token' };
  const runs = (await (await fetch(`${daemon}/v1/runs?active=1`, { headers })).json()) as { runId: string }[];
  for (const r of runs) await fetch(`${daemon}/v1/runs/${r.runId}/cancel`, { method: 'POST', headers });
}

test.describe('default chat (react-ui)', () => {
  test.beforeEach(({ example }) => {
    test.skip(example !== 'default', 'react-ui composer; the headless example has its own test below');
  });

  test('model, effort and permission mode reach the runtime (draft, then next run)', async ({ chat, page }) => {
    await chat.open();
    // allowBypass is off on this server: bypass is never offered.
    expect(await menuLabels(page, '权限')).toEqual(['每次询问', '自动接受编辑', '计划模式', '自动模式']);

    await pickMenu(page, '模型', 'Fake Opus');
    await pickMenu(page, '推理强度', '低');
    await pickMenu(page, '权限', '计划模式');
    await chat.send('echo');
    await expect(chat.assistant.last()).toContainText(echoed('model=fake-opus effort=low mode=plan; attachments: -'));
    await chat.expectRunState('completed');

    // In the open session: applies from the next run.
    await pickMenu(page, '模型', 'Fake Haiku');
    await pickMenu(page, '推理强度', '最高');
    await pickMenu(page, '权限', '自动接受编辑');
    await expect(page.getByRole('button', { name: '模型：Fake Haiku' })).toBeVisible();
    await chat.send('echo again');
    await expect(chat.assistant.last()).toContainText(echoed('model=fake-haiku effort=max mode=acceptEdits; attachments: -'));

    // Stored with the session: still selected after a reload.
    await chat.sessionUrl();
    await page.reload();
    await expect(page.getByRole('button', { name: '模型：Fake Haiku' })).toBeVisible();
    await expect(page.getByRole('button', { name: '推理强度：最高' })).toBeVisible();
    await expect(page.getByRole('button', { name: '权限：自动接受编辑' })).toBeVisible();
  });

  test('image + file attachments: chips, thumbnail + file chip in the bubble, names reach the runtime, kept on reload', async ({ chat, page }) => {
    await chat.open();
    await page.locator('input.uc-file-input').setInputFiles([IMAGE, NOTES]);
    const chips = page.locator('.uc-attachments .uc-attachment');
    await expect(chips).toHaveCount(2);
    await expect(chips.nth(0)).toContainText('uncage-42.png');
    await expect(chips.nth(0).locator('img')).toBeVisible();
    await expect(chips.nth(1)).toContainText('notes.md');

    await chat.send('echo');
    await expect(chat.assistant.last()).toContainText(new RegExp(`attachments: ${BOTH}$`));
    await chat.expectRunState('completed');
    await expect(chips).toHaveCount(0);

    const expectBubble = async () => {
      const thumb = page.locator('.uc-user-attachments .uc-user-thumb img');
      await expect(thumb).toHaveAttribute('alt', 'uncage-42.png');
      // The thumbnail really loads from the daemon (via the proxy).
      await expect.poll(() => thumb.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
      await expect(page.locator('.uc-user-attachments .uc-file-chip')).toContainText('notes.md');
    };
    await expectBubble();
    await chat.sessionUrl();
    await page.reload();
    await expect(chat.userBubbles).toHaveCount(1);
    await expectBubble();
  });

  test('drag and drop and paste attach files; pasted text stays text', async ({ chat, page }) => {
    await chat.open();
    // Synthetic DataTransfer events: what the browser dispatches for a real drop / paste.
    await page.evaluate(() => {
      const box = document.querySelector('.uc-composer')!;
      const dt = new DataTransfer();
      dt.items.add(new File(['dropped'], 'dropped.txt', { type: 'text/plain' }));
      for (const type of ['dragenter', 'dragover', 'drop']) {
        box.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
      }
    });
    const chips = page.locator('.uc-attachments .uc-attachment');
    await expect(chips).toHaveCount(1);
    await expect(chips.first()).toContainText('dropped.txt');

    await chat.input.focus();
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array([137, 80, 78, 71])], 'screenshot.png', { type: 'image/png' }));
      document.querySelector('.uc-composer-input')!.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
    });
    await expect(chips).toHaveCount(2);
    await expect(chips.nth(1)).toContainText('screenshot.png');

    // Clipboard with text (and a file, as office apps put both): the text is pasted, no attachment.
    const defaultPrevented = await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.setData('text/plain', 'hello');
      dt.items.add(new File(['x'], 'copied.txt', { type: 'text/plain' }));
      const e = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt });
      document.querySelector('.uc-composer-input')!.dispatchEvent(e);
      return e.defaultPrevented;
    });
    expect(defaultPrevented).toBe(false);
    await expect(chips).toHaveCount(2);

    await chat.send('echo');
    await expect(chat.assistant.last()).toContainText(/attachments: (dropped\.txt,screenshot\.png|screenshot\.png,dropped\.txt)$/);
  });

  test('11 files: 10 attach, the 11th is refused with the count limit', async ({ chat, page }) => {
    await chat.open();
    const files = Array.from({ length: 11 }, (_, i) => ({ name: `f${i + 1}.txt`, mimeType: 'text/plain', buffer: Buffer.from(`file ${i + 1}`) }));
    await page.locator('input.uc-file-input').setInputFiles(files);
    await expect(page.locator('.uc-attachments .uc-attachment')).toHaveCount(10);
    await expect(page.locator('.uc-composer-caption[data-tone="err"]')).toHaveText('每条消息最多 10 个附件：f11.txt');
  });

  test('running chip: shows 1 during a slow run and jumps to that session', async ({ chat, page }) => {
    await cancelActiveRuns();
    await chat.open();
    await chat.send('slow');
    await chat.expectRunState('running');
    const url = await chat.sessionUrl();
    const sessionId = new URL(url).searchParams.get('session');

    // From another (new) session.
    await page.getByRole('button', { name: '新建会话' }).first().click();
    await expect(chat.userBubbles).toHaveCount(0);
    const chip = page.locator('.uc-running-chip');
    await expect(chip).toHaveText('1 个运行中');
    await chip.click();
    await page.getByRole('menuitem').first().click();
    await expect(page).toHaveURL(new RegExp(`session=${sessionId}`));
    await expect(chat.userBubbles).toHaveText(['slow']);

    await page.locator('.uc-stop').click();
    await chat.expectRunState('cancelled');
    await expect(chip).toHaveCount(0, { timeout: 10_000 });
  });

  test('voice: mic (fake recognizer) shows the privacy note once and types into the box', async ({ chat, page }) => {
    // Headless Chrome has no working speech service: inject a fake SpeechRecognition.
    await page.addInitScript(() => {
      class FakeRecognition {
        lang = '';
        interimResults = false;
        continuous = false;
        onresult: ((e: unknown) => void) | null = null;
        onerror: ((e: { error: string }) => void) | null = null;
        onend: (() => void) | null = null;
        start() {
          const result = (transcript: string, isFinal: boolean) => Object.assign([{ transcript }], { isFinal });
          setTimeout(() => this.onresult?.({ resultIndex: 0, results: [result('你好', false)] }), 50);
          setTimeout(() => this.onresult?.({ resultIndex: 0, results: [result('你好世界', true)] }), 150);
        }
        stop() {
          setTimeout(() => this.onend?.(), 0);
        }
        abort() {
          this.onend?.();
        }
      }
      Object.assign(window, { SpeechRecognition: FakeRecognition });
      localStorage.removeItem('uncage.speechNoticeShown');
    });
    await chat.open();
    await page.getByRole('button', { name: '语音输入' }).click();
    await expect(page.getByText('语音由浏览器厂商的语音服务处理。')).toBeVisible();
    await expect(chat.input).toHaveValue('你好世界');
    const stop = page.getByRole('button', { name: '停止语音输入' });
    await expect(stop).toHaveAttribute('aria-pressed', 'true');
    await stop.click();
    await expect(page.getByRole('button', { name: '语音输入' })).toHaveAttribute('aria-pressed', 'false');
  });

  test('allowBypass server: bypass needs confirmation, shows the banner and reaches the runtime', async ({ page }) => {
    const chat = chatFor(page, 'default');
    await chat.open(`http://localhost:${PORTS.bypassChat}/`);
    expect(await menuLabels(page, '权限')).toContain('完全放行');

    // Cancel keeps the current mode.
    await pickMenu(page, '权限', '完全放行');
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText('Agent 将不经询问执行任何命令，确定开启？');
    await dialog.getByRole('button', { name: '取消' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('button', { name: '权限：每次询问' })).toBeVisible();

    await pickMenu(page, '权限', '完全放行');
    await dialog.getByRole('button', { name: '开启' }).click();
    await expect(page.getByRole('button', { name: '权限：完全放行' })).toBeVisible();
    await chat.send('echo');
    await expect(chat.assistant.last()).toContainText('mode=bypassPermissions');
    await expect(page.locator('.uc-bypass-banner')).toHaveText('已开启完全放行：Agent 会不经询问执行任何命令。');
  });
});

test('headless example: settings and attachments via hooks reach the runtime', async ({ example, chat, page }) => {
  test.skip(example !== 'headless', 'the headless example only');
  await chat.open();
  await expect(page.getByRole('combobox', { name: '权限' }).locator('option')).toHaveText(['每次询问', '自动接受编辑', '计划模式', '自动模式']);
  await page.getByRole('combobox', { name: '模型' }).selectOption('fake-opus');
  await page.getByRole('combobox', { name: '推理强度' }).selectOption('low');
  await page.getByRole('combobox', { name: '权限' }).selectOption('plan');
  await page.getByLabel('添加附件').setInputFiles([IMAGE, NOTES]);
  await expect(page.locator('.attachment-chip')).toHaveCount(2);

  await chat.send('echo');
  await expect(chat.assistant.last()).toContainText(new RegExp(`settings: model=fake-opus effort=low mode=plan; attachments: ${BOTH}$`));
  await chat.expectRunState('completed');
  await expect(page.locator('.attachment-chip')).toHaveCount(0);

  const expectBubble = async () => {
    await expect(page.locator('.msg-attachments img')).toHaveAttribute('alt', 'uncage-42.png');
    await expect.poll(() => page.locator('.msg-attachments img').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
    await expect(page.locator('.msg-attachments .file-chip')).toHaveText('notes.md');
  };
  await expectBubble();

  await page.getByRole('combobox', { name: '权限' }).selectOption('acceptEdits');
  await chat.send('echo again');
  await expect(chat.assistant.last()).toContainText(echoed('model=fake-opus effort=low mode=acceptEdits; attachments: -'));

  await chat.sessionUrl();
  await page.reload();
  await expect(chat.userBubbles).toHaveCount(2);
  await expectBubble();
  await expect(page.getByRole('combobox', { name: '权限' })).toHaveValue('acceptEdits');
});

#!/usr/bin/env node
// Renders the social preview images public/og/og-{en,zh,ja}.png (1200x630) from an HTML template,
// with the copy from src/i18n, using the system Chrome (Playwright `channel: 'chrome'`; no browser
// download). Usage (from apps/site): node scripts/og.mjs   (Node 22.18+, which runs the .ts dictionaries)
/* global console */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { getDict, localeInfo, locales } from '../src/i18n/index.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const siteDir = path.resolve(here, '..');
const brandDir = path.resolve(siteDir, '../../brand');
const outDir = path.join(siteDir, 'public/og');
fs.mkdirSync(outDir, { recursive: true });

const logo = fs.readFileSync(path.join(brandDir, 'logo-horizontal.svg'), 'utf8');
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function html(locale) {
  const t = getDict(locale);
  const title = esc(t.hero.title).replace(/\*([^*]+)\*/, '<em>$1</em>');
  return `<!doctype html><html lang="${localeInfo[locale].lang}"><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; }
  html, body { margin: 0; width: 1200px; height: 630px; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, system-ui, 'Segoe UI', 'PingFang SC', 'Hiragino Sans', sans-serif;
    background: radial-gradient(70% 90% at 100% 0%, #fbe7d3 0%, rgba(251,231,211,0) 60%), #f7f3ec;
    color: #1f2328; padding: 72px 80px; display: flex; flex-direction: column; position: relative; overflow: hidden;
  }
  .logo svg { width: auto; height: 56px; display: block; }
  h1 { margin: auto 0 22px; font-size: 92px; line-height: 1.0; letter-spacing: -0.04em; font-weight: 760; max-width: 900px; }
  :lang(zh-CN) h1, :lang(ja) h1 { letter-spacing: -0.01em; line-height: 1.12; font-size: 84px; }
  em { font-style: normal; color: #c4651a; }
  p { margin: 0; font-size: 34px; color: #4a4f57; }
  .foot { position: absolute; right: 80px; top: 84px; font: 600 22px ui-monospace, 'SF Mono', Menlo, monospace; color: #a14f0c;
    background: #fbe7d3; border: 1px solid rgba(196,101,26,.25); border-radius: 999px; padding: 8px 18px; }
  .bar { position: absolute; left: 0; right: 0; bottom: 0; height: 12px; background: repeating-linear-gradient(90deg, #c4651a 0 24px, transparent 24px 40px); opacity: .9; }
  </style></head><body>
  <div class="logo">${logo}</div>
  <div class="foot">npx uncage setup</div>
  <h1>${title}</h1>
  <p>${esc(t.tagline)}</p>
  <div class="bar"></div>
  </body></html>`;
}

const browser = await chromium.launch({ channel: 'chrome' });
try {
  for (const locale of locales) {
    const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
    await page.setContent(html(locale), { waitUntil: 'load' });
    await page.screenshot({ path: path.join(outDir, `og-${locale}.png`) });
    await page.close();
    console.log(`wrote public/og/og-${locale}.png`);
  }
} finally {
  await browser.close();
}

#!/usr/bin/env node
// Renders the raster brand icons from brand/*.svg into brand/png/ using the system Chrome
// (Playwright `channel: 'chrome'`; no browser download). Usage: node scripts/brand-png.mjs
//
//   favicon-32.png        32x32, transparent, light mark (legacy favicon fallback)
//   apple-touch-icon.png  180x180, full-bleed paper tile (iOS rounds the corners itself)
//   icon-512.png          512x512, full-bleed paper tile (PWA / social / npm avatar)
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Playwright is a dependency of the e2e workspace package; resolve it from there.
const require = createRequire(path.join(root, 'e2e', 'package.json'));
const { chromium } = require('@playwright/test');

const brand = path.join(root, 'brand');
const outDir = path.join(brand, 'png');
fs.mkdirSync(outDir, { recursive: true });

const PAPER = '#f7f3ec';
const markUri = `data:image/svg+xml;base64,${fs.readFileSync(path.join(brand, 'logo-mark.svg')).toString('base64')}`;

/** size: output px; mark: mark px (centered); bg: tile color or null for transparent. */
const targets = [
  { file: 'favicon-32.png', size: 32, mark: 32, bg: null },
  { file: 'apple-touch-icon.png', size: 180, mark: 120, bg: PAPER },
  { file: 'icon-512.png', size: 512, mark: 340, bg: PAPER },
];

const browser = await chromium.launch({ channel: 'chrome' });
try {
  for (const t of targets) {
    const page = await browser.newPage({ viewport: { width: t.size, height: t.size }, deviceScaleFactor: 1 });
    await page.setContent(
      `<html><body style="margin:0;width:${t.size}px;height:${t.size}px;display:grid;place-items:center;background:${t.bg ?? 'transparent'}">` +
        `<img src="${markUri}" width="${t.mark}" height="${t.mark}" style="display:block"></body></html>`,
    );
    await page.waitForFunction(() => document.images[0]?.complete);
    await page.screenshot({ path: path.join(outDir, t.file), omitBackground: t.bg === null });
    await page.close();
    console.log(`wrote brand/png/${t.file}`);
  }
} finally {
  await browser.close();
}

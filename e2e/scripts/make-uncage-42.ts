// Generates e2e/fixtures/uncage-42.png: the text UNCAGE-42, black on white, drawn from a 5×7 bitmap
// font with a minimal PNG encoder (no canvas, no downloads). Run: node e2e/scripts/make-uncage-42.ts
import { writeFileSync } from 'node:fs';
import { crc32, deflateSync } from 'node:zlib';

const TEXT = 'UNCAGE-42';
const SCALE = 10;
const MARGIN = 40;

const GLYPHS: Record<string, string[]> = {
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  C: ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  G: ['01110', '10001', '10000', '10111', '10001', '10001', '01111'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
};

const cell = 6 * SCALE; // 5 columns + 1 column of spacing
const width = MARGIN * 2 + TEXT.length * cell - SCALE;
const height = MARGIN * 2 + 7 * SCALE;

/** 8-bit grayscale pixels, white background. */
const pixels = Buffer.alloc(width * height, 0xff);
[...TEXT].forEach((ch, i) => {
  const glyph = GLYPHS[ch];
  if (!glyph) throw new Error(`no glyph for ${ch}`);
  glyph.forEach((row, gy) => {
    [...row].forEach((bit, gx) => {
      if (bit !== '1') return;
      for (let dy = 0; dy < SCALE; dy++) {
        const y = MARGIN + gy * SCALE + dy;
        const x = MARGIN + i * cell + gx * SCALE;
        pixels.fill(0x00, y * width + x, y * width + x + SCALE);
      }
    });
  });
});

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(width, 0);
ihdr.writeUInt32BE(height, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 0; // grayscale
// compression, filter, interlace: 0

// Each scanline is prefixed with filter type 0 (none).
const raw = Buffer.alloc((width + 1) * height);
for (let y = 0; y < height; y++) pixels.copy(raw, y * (width + 1) + 1, y * width, (y + 1) * width);

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw)),
  chunk('IEND', Buffer.alloc(0)),
]);

const out = new URL('../fixtures/uncage-42.png', import.meta.url);
writeFileSync(out, png);
console.log(`wrote ${out.pathname} (${width}×${height}, ${png.length} bytes)`);

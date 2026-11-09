import { encode } from 'uqr';

const QUIET = 2; // modules of white border (the spec asks for 4; 2 scans fine on phones and keeps it compact)

/**
 * A compact terminal QR code: two rows of modules per text line using half blocks. Drawn as black
 * on an explicit white background, so it scans on dark and light terminal themes alike.
 */
export function renderQr(text: string): string {
  const matrix = encode(text, { ecc: 'L', border: QUIET }).data.map((r) => r.slice());
  if (matrix.length % 2) matrix.push(new Array<boolean>(matrix[0]!.length).fill(false));
  const lines: string[] = [];
  for (let y = 0; y < matrix.length; y += 2) {
    let line = '';
    for (let x = 0; x < matrix[y]!.length; x++) {
      const top = matrix[y]![x]!;
      const bottom = matrix[y + 1]![x]!;
      line += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' ';
    }
    lines.push(`\x1b[30;47m${line}\x1b[0m`);
  }
  return lines.join('\n');
}

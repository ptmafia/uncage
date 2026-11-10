/**
 * A string from elsewhere (a hub's answer, an error message) made safe to print in a terminal or a
 * dialog: line breaks and tabs become spaces; other control characters (ESC sequences, BEL, C1) and
 * bidirectional overrides are dropped.
 */
export function plainText(s: string): string {
  return s.replace(/[\t\n\r]+/g, ' ').replace(/[\p{Cc}‪-‮⁦-⁩]/gu, '');
}

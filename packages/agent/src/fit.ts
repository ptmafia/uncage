import type { UncageEvent } from '@uncage/protocol';

const byteLength = (s: string): number => Buffer.byteLength(s, 'utf8');

/** Marker appended to a string field cut to make an event fit in one frame. */
export const truncationMarker = (bytes: number): string => `…[truncated ${bytes} bytes]`;

type Leaf = { holder: Record<string, unknown> | unknown[]; key: string | number; value: string };

function stringLeaves(v: unknown, out: Leaf[], holder?: Leaf['holder'], key?: Leaf['key']): void {
  if (typeof v === 'string') {
    if (holder !== undefined && key !== undefined) out.push({ holder, key, value: v });
  } else if (Array.isArray(v)) v.forEach((x, i) => stringLeaves(x, out, v, i));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) stringLeaves(x, out, v as Record<string, unknown>, k);
}

/**
 * Returns `e` unchanged when its JSON fits in `budget` bytes; otherwise a copy whose largest string
 * fields in `payload` (message text, tool output, input, …) are cut, each ending with
 * `…[truncated N bytes]`, until it fits. Sequence and ids are untouched, so a replica stays
 * gap-free. Only the copy sent to the hub is truncated; the local event keeps its full content.
 */
export function fitEvent(e: UncageEvent, budget: number): UncageEvent {
  let size = byteLength(JSON.stringify(e));
  if (size <= budget) return e;
  const copy = structuredClone(e) as UncageEvent & { payload: unknown };
  const leaves: Leaf[] = [];
  stringLeaves(copy.payload, leaves);
  leaves.sort((a, b) => b.value.length - a.value.length);
  for (const leaf of leaves) {
    if (size <= budget) break;
    const bytes = Buffer.from(leaf.value, 'utf8');
    const before = byteLength(JSON.stringify(leaf.value));
    // Target encoded size for this field; JSON escaping may inflate, so shrink until it fits.
    let target = Math.max(0, before - (size - budget) - 64);
    for (;;) {
      const kept = prefixWithin(bytes, target);
      const next = `${kept}${truncationMarker(bytes.length - byteLength(kept))}`;
      const delta = byteLength(JSON.stringify(next)) - before;
      if (size + delta <= budget || target === 0) {
        (leaf.holder as Record<string | number, unknown>)[leaf.key] = next;
        size += delta;
        break;
      }
      target = Math.max(0, target - (size + delta - budget) - 64);
    }
  }
  return copy;
}

/** The longest prefix of `bytes` (UTF-8) of at most `max` bytes that ends on a character boundary. */
function prefixWithin(bytes: Buffer, max: number): string {
  let end = Math.min(max, bytes.length);
  // Step back over UTF-8 continuation bytes (10xxxxxx) so no character is split.
  while (end > 0 && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString('utf8');
}

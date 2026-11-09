import { z } from 'zod';

/** Largest accepted icon data URI (each variant), in bytes. Larger icons are dropped. */
export const MAX_RUNTIME_ICON_BYTES = 16 * 1024;

const DATA_URI = /^data:image\/(?:svg\+xml|png);base64,[A-Za-z0-9+/]+={0,2}$/;

/**
 * A base64 `data:image/svg+xml` or `data:image/png` URI of at most 16 KiB. Icons travel with the
 * runtime info so a website never fetches them from a third party; they are only ever rendered as
 * `<img src>` (an SVG in an `<img>` cannot run scripts).
 */
export const isImageDataUri = (s: unknown): s is string => typeof s === 'string' && s.length <= MAX_RUNTIME_ICON_BYTES && DATA_URI.test(s);

const IconDataUriSchema = z.string().refine(isImageDataUri, { message: 'expected a base64 svg/png data URI of at most 16 KiB' });

/** A runtime's icon: `light` for light backgrounds, optional `dark` for dark ones. */
export const RuntimeIconSchema = z.object({ light: IconDataUriSchema, dark: IconDataUriSchema.optional() });
export type RuntimeIcon = z.infer<typeof RuntimeIconSchema>;

/** The icon with invalid or oversized variants dropped; undefined without a valid `light` variant. */
export function sanitizeRuntimeIcon(icon: unknown): RuntimeIcon | undefined {
  if (!icon || typeof icon !== 'object') return undefined;
  const { light, dark } = icon as { light?: unknown; dark?: unknown };
  if (!isImageDataUri(light)) return undefined;
  return isImageDataUri(dark) ? { light, dark } : { light };
}

/** For wire schemas: an invalid icon becomes `undefined` instead of failing the whole record. */
export const LenientRuntimeIconSchema = z.unknown().transform((v) => sanitizeRuntimeIcon(v)).optional();

import { en } from './en.ts';
import type { Dict } from './schema.ts';

/**
 * PLACEHOLDER: an English copy until the ja translation lands (Task 5 of the website plan).
 * Replace this whole object with translated copy written against `Dict`, then set `pending`
 * to false so tests/i18n.test.ts also checks that no value is left in English.
 */
export const pending = true;

export const ja: Dict = structuredClone(en);

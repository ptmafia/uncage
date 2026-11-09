/**
 * The site tool and the notes table. A site tool runs on the Worker (in the request that carries
 * the agent's tool call), as the session's owner; the user's machine only sees its name,
 * description and JSON Schema.
 */
import { defineTool, type PgPoolLike, type SiteTool } from '@uncage/hub';
import { z } from 'zod';

export interface Note {
  id: string;
  title: string;
  body: string;
  createdAt: string;
}

export interface NotesDb {
  add(owner: string, title: string, body: string): Promise<Note>;
  list(owner: string): Promise<Note[]>;
}

/** Arbitrary advisory-lock key for creating the notes table ("cfno" in ASCII). */
const SCHEMA_LOCK_KEY = 0x63666e6f;

/**
 * Databases whose notes table exists, for the isolate's life. Keyed by connection string when one is
 * given (a Worker builds a new pool per request, so a pool object never repeats), else by pool.
 */
const readyUrls = new Set<string>();
const readyPools = new WeakSet<PgPoolLike>();

async function ensureSchema(pool: PgPoolLike, key: string | undefined): Promise<void> {
  if (key !== undefined ? readyUrls.has(key) : readyPools.has(pool)) return;
  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    // One transaction under a transaction-scoped lock: concurrent first requests (and transaction
    // poolers such as Hyperdrive) cannot race CREATE TABLE IF NOT EXISTS.
    await client.query('BEGIN');
    try {
      await client.query('SELECT pg_advisory_xact_lock($1)', [SCHEMA_LOCK_KEY]);
      await client.query(`CREATE TABLE IF NOT EXISTS cf_demo_notes (
        id bigserial PRIMARY KEY,
        owner text NOT NULL,
        title text NOT NULL,
        body text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
      await client.query('CREATE INDEX IF NOT EXISTS cf_demo_notes_owner ON cf_demo_notes (owner, id)');
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch((re: unknown) => (broken = re instanceof Error ? re : new Error(String(re))));
      throw e;
    }
  } finally {
    client.release(broken);
  }
  if (key !== undefined) readyUrls.add(key);
  else readyPools.add(pool);
}

type Row = { id: string | number; title: string; body: string; created_at: string | Date };
const toNote = (r: Row): Note => ({
  id: String(r.id),
  title: r.title,
  body: r.body,
  createdAt: new Date(r.created_at).toISOString(),
});

/** Notes in `cf_demo_notes`, created on first use. `cacheKey`: the connection string, if any. */
export function notesDb(pool: PgPoolLike, cacheKey?: string): NotesDb {
  return {
    async add(owner, title, body) {
      await ensureSchema(pool, cacheKey);
      const { rows } = await pool.query(
        'INSERT INTO cf_demo_notes (owner, title, body) VALUES ($1, $2, $3) RETURNING id, title, body, created_at',
        [owner, title, body],
      );
      return toNote(rows[0] as Row);
    },
    async list(owner) {
      await ensureSchema(pool, cacheKey);
      const { rows } = await pool.query(
        'SELECT id, title, body, created_at FROM cf_demo_notes WHERE owner = $1 ORDER BY id DESC LIMIT 100',
        [owner],
      );
      return (rows as Row[]).map(toNote);
    },
  };
}

/** `save_note`: stores a note for the signed-in user who owns the session (`ctx.user`). */
export function saveNoteTool(notes: NotesDb): SiteTool<{ title: string; body: string }> {
  return defineTool({
    name: 'save_note',
    description: "Save a note (title and body) to the website, in the signed-in user's notes. It shows on the website's /notes page.",
    input: z.object({
      title: z.string().trim().min(1).max(120).describe('Short title of the note'),
      body: z.string().max(4000).describe('The note itself, plain text or Markdown'),
    }),
    handler: async ({ title, body }, ctx) => {
      const note = await notes.add(ctx.user.id, title, body);
      return { saved: true, noteId: note.id, title, next: 'Tell the user the note is saved and shows on the website\'s /notes page.' };
    },
  });
}

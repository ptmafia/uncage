import { createUncageHandler } from '@uncage/server/proxy';

// Node runtime and no caching, so event streams (SSE) pass straight through.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const { GET, POST, PATCH } = createUncageHandler();

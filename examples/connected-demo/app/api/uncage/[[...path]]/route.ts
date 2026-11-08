/**
 * The hub as a Next.js route handler: the FaaS-mode entry (`next start`, Vercel; see lib/mode.ts).
 * Browser API, device endpoints, install.sh, the agents' HTTP streaming transport and the
 * `/maintenance` cron endpoint, all under /api/uncage.
 *
 * In traditional mode server.ts answers /api/uncage before Next.js sees it, so this file is unused
 * there (and would serve the same published hub if reached).
 */
import { toNextHandlers } from '@uncage/hub';
import { after } from 'next/server';
import { clientIpResolver } from '../../../../lib/hub.ts';
import { getHub } from '../../../../lib/hub-registry.ts';
import { demoMode, faasAttachmentLimit } from '../../../../lib/mode.ts';

// CLIENT_IP_HEADER / TRUST_PROXY when set; otherwise, on Vercel, the address its edge sets.
const clientIp = clientIpResolver(process.env);

// `after`: the hub's background work (opportunistic maintenance) never delays a response.
const handlers = toNextHandlers(getHub, { ...(clientIp ? { clientIp } : {}), waitUntil: after });

export const { GET, PATCH, DELETE } = handlers;

/** FaaS mode: attachments over 4 MB get the hub's error, not Vercel's body-size 413 (see lib/mode.ts). */
export async function POST(req: Request): Promise<Response> {
  return (demoMode() === 'faas' ? faasAttachmentLimit(req) : null) ?? handlers.POST(req);
}

/** Seconds a function may run (Vercel); the hub ends its streams earlier (UNCAGE_STREAM_MAX_MS, default 250 s). */
export const maxDuration = 300;
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

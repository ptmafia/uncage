import { wellKnownResponse } from '../../../lib/app-routes.ts';

/** iOS universal links for the companion app, from APPLE_TEAM_ID + IOS_BUNDLE_ID (404 when unset). */
export const GET = (): Response => wellKnownResponse('apple-app-site-association');

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

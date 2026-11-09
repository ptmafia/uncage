import { wellKnownResponse } from '../../../lib/app-routes.ts';

/** Android App Links for the companion app, from ANDROID_PACKAGE + ANDROID_SHA256 (404 when unset). */
export const GET = (): Response => wellKnownResponse('assetlinks.json');

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

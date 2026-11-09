import { handleAppToken } from '../../../../lib/app-routes.ts';

/** The companion app's sign-in: an app token for `Authorization: Bearer` (see lib/app-routes.ts). */
export const POST = (req: Request): Promise<Response> => handleAppToken(req);

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { handlePushToken } from '../../../../lib/app-routes.ts';

/** Registers (POST) or removes (DELETE) the signed-in user's Expo push token (see lib/app-routes.ts). */
export const POST = (req: Request): Promise<Response> => handlePushToken(req);
export const DELETE = (req: Request): Promise<Response> => handlePushToken(req);

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

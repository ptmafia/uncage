import { SESSION_COOKIE } from '../../../lib/auth.ts';
import { isSameOrigin } from '../../../lib/csrf.ts';

export async function POST(req: Request): Promise<Response> {
  if (!isSameOrigin(req)) return new Response('Cross-site request refused', { status: 403 });
  return new Response(null, {
    status: 303,
    headers: { location: '/login', 'set-cookie': `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0` },
  });
}

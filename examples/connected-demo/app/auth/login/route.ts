import { normalizeUsername, SESSION_COOKIE, signUser } from '../../../lib/auth.ts';
import { isSameOrigin } from '../../../lib/csrf.ts';
import { safeNext } from '../../../lib/session-utils.ts';

/** DEMO-ONLY: signs in as any username (no password). */
export async function POST(req: Request): Promise<Response> {
  if (!isSameOrigin(req)) return new Response('Cross-site request refused', { status: 403 });
  const form = await req.formData();
  const next = safeNext(form.get('next'));
  const name = normalizeUsername(form.get('username'));
  if (!name) return new Response(null, { status: 303, headers: { location: `/login?error=1&next=${encodeURIComponent(next)}` } });
  const secure = new URL(req.url).protocol === 'https:' ? '; Secure' : '';
  return new Response(null, {
    status: 303,
    headers: {
      location: next,
      'set-cookie': `${SESSION_COOKIE}=${encodeURIComponent(signUser(name))}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure}`,
    },
  });
}

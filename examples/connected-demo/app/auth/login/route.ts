import { guestUsername, normalizeUsername, SESSION_COOKIE, signUser } from '../../../lib/auth.ts';
import { isPublicDemo, publicUrl } from '../../../lib/config.ts';
import { isSameOrigin } from '../../../lib/csrf.ts';
import { safeNext } from '../../../lib/session-utils.ts';

/**
 * DEMO-ONLY: signs in as any username (no password). With `DEMO_PUBLIC=1` the name is ignored and
 * a random guest identity is handed out instead, so nobody can take over someone else's account.
 */
export async function POST(req: Request): Promise<Response> {
  if (!isSameOrigin(req)) return new Response('Cross-site request refused', { status: 403 });
  const form = await req.formData();
  const next = safeNext(form.get('next'));
  const name = isPublicDemo() ? guestUsername() : normalizeUsername(form.get('username'));
  if (!name) return new Response(null, { status: 303, headers: { location: `/login?error=1&next=${encodeURIComponent(next)}` } });
  // Behind a TLS-terminating proxy (Railway, Render) req.url is plain http, so ask PUBLIC_URL too.
  const https = new URL(req.url).protocol === 'https:' || publicUrl().startsWith('https:');
  return new Response(null, {
    status: 303,
    headers: {
      location: next,
      'set-cookie': `${SESSION_COOKIE}=${encodeURIComponent(signUser(name))}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${https ? '; Secure' : ''}`,
    },
  });
}

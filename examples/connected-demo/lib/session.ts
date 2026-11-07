/** Next.js-side helpers for the DEMO-ONLY cookie sign-in (see lib/auth.ts). */
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { SESSION_COOKIE, verifyUser } from './auth.ts';

export async function currentUser(): Promise<{ id: string; name: string } | null> {
  const name = verifyUser((await cookies()).get(SESSION_COOKIE)?.value);
  return name ? { id: name, name } : null;
}

/** The signed-in user, or a redirect to /login that comes back to `path`. */
export async function requireUser(path: string): Promise<{ id: string; name: string }> {
  const user = await currentUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(path)}`);
  return user;
}

import { getHub } from '../../lib/hub-registry.ts';
import { requireUser } from '../../lib/session.ts';
import { ApprovePage } from './approve-page.tsx';

export const dynamic = 'force-dynamic';

/**
 * Where `uncage setup <this site>` sends the user (`/device?code=…`). A code from the URL is
 * untrusted (anyone can send the link): ApprovePage shows it with `source="link"` (warning, request
 * time and IP, type the last 4 characters). Plain `/device` lets the user type the whole code. next.config.ts makes it
 * unframeable (frame-ancestors 'none' + X-Frame-Options: DENY); the decision is a Server Action
 * (POST, Origin-checked by Next.js) made with the signed-in user — never a GET.
 */
export default async function DevicePage({ searchParams }: { searchParams: Promise<{ code?: string }> }) {
  const { code = '' } = await searchParams;
  const user = await requireUser(`/device${code ? `?code=${encodeURIComponent(code)}` : ''}`);
  // A link code must be exactly what the CLI prints (ABCD-EFGH): padding such as `ABCD-EFGH----`
  // could put the hidden last 4 characters on screen. Anything else is not looked up.
  // (Same check as @uncage/react's isWellFormedDeviceCode, inlined: this is a Server Component and
  // @uncage/react imports React client hooks, which Next.js refuses on the server.)
  const wellFormed = /^[A-Z0-9]{4}-?[A-Z0-9]{4}$/i.test(code.trim());
  if (code && !wellFormed) {
    return (
      <div className="demo-device">
        <ApprovePage code="" lookup={null} invalidLink />
      </div>
    );
  }
  let lookup = null;
  let error: { code: string; message: string } | undefined;
  try {
    lookup = code ? await (await getHub()).lookupDevice(code, user) : null;
  } catch (e) {
    const err = e as { code?: string; message?: string };
    error = { code: err.code ?? 'internal_error', message: err.message ?? 'Failed' };
  }
  return (
    <div className="demo-device">
      <ApprovePage code={code} lookup={lookup} initialError={error} />
    </div>
  );
}

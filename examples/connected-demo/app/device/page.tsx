import { getHub } from '../../lib/hub-registry.ts';
import { requireUser } from '../../lib/session.ts';
import { ApprovePage } from './approve-page.tsx';

export const dynamic = 'force-dynamic';

/**
 * Where `uncage setup <this site>` sends the user (`/device?code=…`). next.config.ts makes it
 * unframeable (frame-ancestors 'none' + X-Frame-Options: DENY); the decision is a Server Action
 * (POST, Origin-checked by Next.js) made with the signed-in user — never a GET.
 */
export default async function DevicePage({ searchParams }: { searchParams: Promise<{ code?: string }> }) {
  const { code = '' } = await searchParams;
  const user = await requireUser(`/device${code ? `?code=${encodeURIComponent(code)}` : ''}`);
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

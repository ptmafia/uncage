/**
 * Every link that opens the app passes here first. A `/device?code=` link (the CLI's QR code, via
 * Android App Links / iOS universal links, or `uncagedemo://device?code=`) is remembered, so if the
 * user has to sign in first the sign-in screen can still open the approval afterwards.
 */
import { setPendingDeviceCode } from '../lib/app';
import { deviceCodeFromPath } from '../lib/links';

export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  try {
    const code = deviceCodeFromPath(path);
    if (code) {
      setPendingDeviceCode(code);
      return `/device?code=${encodeURIComponent(code)}`;
    }
  } catch {
    // never crash on a strange link
  }
  return path;
}

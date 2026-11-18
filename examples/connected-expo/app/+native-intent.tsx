/**
 * Every link that opens the app passes here first. A `/device` link opens the approve screen:
 *
 * - a verified https App Link / Universal Link for the site (the CLI's QR code) carries its code;
 *   it is remembered, so if the user has to sign in first the sign-in screen can still open the
 *   approval afterwards, and the user still types the code's last 4 characters;
 * - anything else (`uncagedemo://device?code=`, which any app or web page can fire, Expo Go's
 *   `exp://`, another host) opens the manual-entry screen without the code (device-approval
 *   phishing guard; see lib/links.ts).
 */
import { SITE_URL, setPendingDeviceCode } from '../lib/app';
import { routeDeviceLink } from '../lib/links';

export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  try {
    const to = routeDeviceLink(path, SITE_URL);
    if (to) {
      setPendingDeviceCode(to.pendingCode);
      return to.route;
    }
  } catch {
    // never crash on a strange link
  }
  return path;
}

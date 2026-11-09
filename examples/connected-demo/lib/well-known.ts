/**
 * App links for the companion app (examples/connected-expo): with these files the device approval
 * link `https://<site>/device?code=…` (the CLI's QR code) opens the app instead of the browser.
 *
 * - Android App Links: `/.well-known/assetlinks.json` from `ANDROID_PACKAGE` + `ANDROID_SHA256`
 *   (the signing certificate's SHA-256 fingerprint(s), comma-separated: e.g. the EAS development
 *   build's and the release key's).
 * - iOS universal links: `/.well-known/apple-app-site-association` from `APPLE_TEAM_ID` +
 *   `IOS_BUNDLE_ID` (needs a paid Apple Developer account; not verified on a device).
 *
 * Each file exists only when its variables are set and valid (invalid values: 404 and a warning).
 */
type Env = Record<string, string | undefined>;

const PACKAGE = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/;
const FINGERPRINT = /^[0-9A-F]{2}(?::[0-9A-F]{2}){31}$/;
const TEAM_ID = /^[A-Z0-9]{10}$/;
const BUNDLE_ID = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;

const warned = new Set<string>();
function warn(message: string): null {
  if (!warned.has(message)) console.warn(message);
  warned.add(message);
  return null;
}

/** The Digital Asset Links statement list, or null when not configured. */
export function assetLinks(env: Env = process.env) {
  const pkg = env.ANDROID_PACKAGE?.trim();
  const raw = env.ANDROID_SHA256?.trim();
  if (!pkg || !raw) return null;
  if (!PACKAGE.test(pkg)) return warn(`ANDROID_PACKAGE is not a valid Android package name: ${pkg}. /.well-known/assetlinks.json is not served.`);
  const fingerprints = raw.split(',').map((f) => f.trim().toUpperCase()).filter(Boolean);
  if (fingerprints.length === 0 || !fingerprints.every((f) => FINGERPRINT.test(f))) {
    return warn('ANDROID_SHA256 must be SHA-256 fingerprints like AB:CD:…, 32 hex pairs, comma-separated. /.well-known/assetlinks.json is not served.');
  }
  return [
    {
      relation: ['delegate_permission/common.handle_all_urls'],
      target: { namespace: 'android_app', package_name: pkg, sha256_cert_fingerprints: [...new Set(fingerprints)] },
    },
  ];
}

/** The apple-app-site-association document (universal links for `/device`), or null when not configured. */
export function appleAppSiteAssociation(env: Env = process.env) {
  const team = env.APPLE_TEAM_ID?.trim();
  const bundle = env.IOS_BUNDLE_ID?.trim();
  if (!team || !bundle) return null;
  if (!TEAM_ID.test(team) || !BUNDLE_ID.test(bundle)) {
    return warn('APPLE_TEAM_ID must be 10 upper-case letters or digits and IOS_BUNDLE_ID a bundle id like com.example.app. /.well-known/apple-app-site-association is not served.');
  }
  return {
    applinks: {
      details: [{ appIDs: [`${team}.${bundle}`], components: [{ '/': '/device', comment: 'Device approval (scan-to-connect)' }] }],
    },
  };
}

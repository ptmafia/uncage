import { createUncageClient } from '@uncage/client';
import { AgentChat, UncageProvider } from '@uncage/react-ui';
import '@uncage/react-ui/styles.css';
import { createRoot } from 'react-dom/client';

/**
 * The site's hub, reached from the extension's own origin (chrome-extension://<id>). Two things make
 * that work:
 *  - `credentials: 'include'` + the manifest's host permission for the hub's origin send the user's
 *    cookies for the site, so the hub's `getUser` sees the user already signed in on the site;
 *  - the hub lists this extension in `HubOptions.trustedOrigins`, so its cross-site guard lets the
 *    extension's POSTs through.
 */
const client = createUncageClient({
  baseUrl: `${__HUB_ORIGIN__}/api/uncage`,
  fetch: (url, init) => fetch(url, { ...init, credentials: 'include' }),
});

createRoot(document.getElementById('root')!).render(
  <UncageProvider client={client}>
    <AgentChat />
  </UncageProvider>,
);

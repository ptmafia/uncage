// Support file for type-checking the homepage samples (not shown on the site).
import type { HubUser } from '@uncage/hub';

export async function getSessionUser(req: Request): Promise<HubUser | null> {
  return req.headers.has('cookie') ? { id: 'user_1', name: 'Ada' } : null;
}

import { defineTool } from '@uncage/hub';
import { z } from 'zod';
import { db } from './db.ts';

export const publishPage = defineTool({
  name: 'publish_page',
  description: 'Publish an HTML page on your site.',
  input: z.object({ title: z.string(), html: z.string() }),
  requiresConfirmation: true, // Allow / Deny card
  handler: async ({ title, html }, ctx) => {
    const owner = ctx.user.id; // the signed-in user
    const page = await db.pages.create({ owner, title, html });
    return { url: page.url };
  },
});

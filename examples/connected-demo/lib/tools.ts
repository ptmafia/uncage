/**
 * The demo's site tools. They run on the hub (inside this website's server), as the signed-in user
 * who owns the session; the user's machine only sees their names, descriptions and JSON Schemas.
 */
import { defineTool, type SiteTool } from '@uncage/hub';
import { z } from 'zod';
import { createAsset, getAsset, publishAsset } from './assets.ts';

/** Total bytes one publish may pull from the machine. */
export const PUBLISH_MAX_BYTES = 20 * 1024 * 1024;

export const createAssetTool = defineTool({
  name: 'create_asset',
  description:
    'Create a new, empty asset on the website (for example a landing page) and get its assetId. Call this before publish_asset.',
  input: z.object({
    title: z.string().trim().min(1).max(120).describe('Human-readable title shown in the website gallery'),
    kind: z.literal('landing-page'),
  }),
  handler: async ({ title, kind }, ctx) => {
    const asset = await createAsset({ owner: ctx.user.id, title, kind, sessionId: ctx.sessionId });
    return {
      assetId: asset.id,
      status: asset.status,
      next: 'Build the page in a folder of the workspace (index.html at its top level), then call publish_asset with this assetId and that folder.',
    };
  },
});

/**
 * A pulled path relative to the requested folder (`site/index.html` → `index.html`). `.`, `./`
 * and trailing slashes mean the workspace root. A path outside `dir/` (e.g. `dir` named a file)
 * is refused: the published layout must mirror the folder exactly.
 */
export function pageRelative(dir: string, path: string): string {
  const root = dir.replace(/^(?:\.\/+)+/, '').replace(/\/+$/, '');
  const prefix = root === '' || root === '.' ? '' : `${root}/`;
  if (!path.startsWith(prefix) || path.length === prefix.length) {
    throw new Error(`"${dir}" must be a folder of the workspace containing index.html (got the file ${path}).`);
  }
  return path.slice(prefix.length);
}

export const publishAssetTool = defineTool({
  name: 'publish_asset',
  description:
    'Publish a folder of the workspace as the asset\'s files (index.html entry, at most 20 MB). The website copies the files and shows the page in its gallery. The user confirms each publish.',
  input: z.object({
    assetId: z.string().min(1).max(40).describe('The assetId returned by create_asset'),
    dir: z.string().trim().min(1).max(200).describe('Folder relative to the workspace, e.g. "landing"'),
  }),
  requiresConfirmation: true,
  handler: async ({ assetId, dir }, ctx) => {
    const asset = await getAsset(assetId);
    // Same message for "missing" and "someone else's": never confirm that another user's id exists.
    if (!asset || asset.owner !== ctx.user.id) throw new Error(`Unknown asset ${assetId}. Create one with create_asset first.`);
    const pull = ctx.files.pull(dir, { maxBytes: PUBLISH_MAX_BYTES });
    const files: Array<{ path: string; data: Uint8Array }> = [];
    for await (const f of pull) files.push({ path: pageRelative(dir, f.path), data: f.data });
    const published = await publishAsset(assetId, files);
    return {
      assetId,
      status: published.status,
      files: published.files?.map((f) => f.path),
      url: `/assets/${assetId}`,
      ...(pull.skipped.length > 0 ? { skipped: pull.skipped } : {}),
    };
  },
});

export const demoTools: SiteTool[] = [createAssetTool, publishAssetTool];

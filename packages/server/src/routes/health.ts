import type { HealthResponse } from '@uncage/protocol';
import type { FastifyInstance } from 'fastify';
import type { RouteContext } from '../context.js';
import pkg from '../../package.json' with { type: 'json' };

export function healthRoutes(app: FastifyInstance, ctx: RouteContext): void {
  // Behind the bearer token like every route; the workspace lets `uncage doctor` check the right repo.
  app.get(
    '/v1/health',
    async (): Promise<HealthResponse> => ({
      ok: true,
      protocol: '1.0',
      version: pkg.version,
      workspace: { default: ctx.uncage.workspace.default, allowedRoots: [...ctx.uncage.workspace.allowedRoots] },
    }),
  );
}

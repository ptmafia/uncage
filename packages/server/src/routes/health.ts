import type { HealthResponse } from '@uncage/protocol';
import type { FastifyInstance } from 'fastify';
import pkg from '../../package.json' with { type: 'json' };

export function healthRoutes(app: FastifyInstance): void {
  app.get('/v1/health', async (): Promise<HealthResponse> => ({ ok: true, protocol: '1.0', version: pkg.version }));
}

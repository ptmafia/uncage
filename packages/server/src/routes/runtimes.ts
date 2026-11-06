import type { FastifyInstance } from 'fastify';
import type { RouteContext } from '../context.js';

export function runtimeRoutes(app: FastifyInstance, { uncage }: RouteContext): void {
  app.get('/v1/runtimes', () => uncage.runtimes.list());
}

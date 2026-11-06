import { UncageError } from '@uncage/core';
import type { FastifyInstance } from 'fastify';
import type { RouteContext } from '../context.js';

type IdParams = { Params: { id: string } };

export function runRoutes(app: FastifyInstance, { uncage }: RouteContext): void {
  /** Runs still in progress on this server, across all sessions. Only `?active=1` is supported. */
  app.get<{ Querystring: { active?: string } }>('/v1/runs', (request) => {
    if (request.query.active !== '1') {
      throw new UncageError('invalid_request', { message: 'Only GET /v1/runs?active=1 is supported.' });
    }
    return uncage.runs.listActive();
  });

  app.get<IdParams>('/v1/runs/:id', (request) => uncage.runs.get(request.params.id));

  app.post<IdParams>('/v1/runs/:id/cancel', async (request, reply) =>
    reply.code(202).send(await uncage.runs.cancel(request.params.id)),
  );
}

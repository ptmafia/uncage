import type { FastifyInstance } from 'fastify';
import type { RouteContext } from '../context.js';

type IdParams = { Params: { id: string } };

export function runRoutes(app: FastifyInstance, { uncage }: RouteContext): void {
  app.get<IdParams>('/v1/runs/:id', (request) => uncage.runs.get(request.params.id));

  app.post<IdParams>('/v1/runs/:id/cancel', async (request, reply) =>
    reply.code(202).send(await uncage.runs.cancel(request.params.id)),
  );
}

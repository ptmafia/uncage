import { UncageError } from '@uncage/core';
import { CreateSessionBodySchema, parseEventId, StartRunBodySchema, type UncageEvent } from '@uncage/protocol';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { idempotencyKey, nonNegativeInt, parse, type RouteContext } from '../context.js';
import { streamEvents } from '../sse.js';

type IdParams = { Params: { id: string } };
type EventsRequest = FastifyRequest<IdParams & { Querystring: { after?: string; limit?: string } }>;

const JSON_EVENTS_LIMIT = 1000;

/** Resume point: `Last-Event-ID` wins over `?after`; both default to 0. */
function resumeAfter(request: EventsRequest): number {
  const lastEventId = request.headers['last-event-id'];
  if (typeof lastEventId === 'string' && lastEventId !== '') {
    const seq = parseEventId(lastEventId);
    if (seq === null) throw new UncageError('invalid_request', { message: 'Last-Event-ID is not a valid event id.' });
    return seq;
  }
  return nonNegativeInt(request.query.after, 'after') ?? 0;
}

/** JSON array mode (doctor export) only when asked for explicitly; SSE is the default. */
const wantsJson = (request: FastifyRequest): boolean => {
  const accept = (request.headers.accept ?? '').toLowerCase();
  return accept.includes('application/json') && !accept.includes('text/event-stream');
};

export function sessionRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const { uncage } = ctx;

  app.get('/v1/sessions', () => uncage.sessions.list());

  app.post('/v1/sessions', async (request, reply) => {
    const session = await uncage.sessions.create(parse(CreateSessionBodySchema, request.body));
    return reply.code(201).send(await session.get());
  });

  app.get<IdParams>('/v1/sessions/:id', async (request) => (await uncage.sessions.get(request.params.id)).snapshot());

  app.post<IdParams>('/v1/sessions/:id/runs', async (request, reply) => {
    const key = idempotencyKey(request);
    const body = parse(StartRunBodySchema, request.body);
    const session = await uncage.sessions.get(request.params.id);
    return reply.code(202).send(await session.startRun({ ...body, idempotencyKey: key }));
  });

  app.get<IdParams & { Querystring: { after?: string; limit?: string } }>(
    '/v1/sessions/:id/events',
    async (request, reply) => {
      const after = resumeAfter(request);
      const session = await uncage.sessions.get(request.params.id);
      if (!wantsJson(request)) {
        return streamEvents(request, reply, session, { after, heartbeatMs: ctx.heartbeatMs, shutdown: ctx.shutdown });
      }

      const limit = Math.min(nonNegativeInt(request.query.limit, 'limit') ?? JSON_EVENTS_LIMIT, JSON_EVENTS_LIMIT);
      const { lastSequence } = await session.snapshot();
      const events: UncageEvent[] = [];
      if (after >= lastSequence || limit === 0) return events;
      // The core iterator never ends on its own: stop at the current tail or the page limit.
      const ac = new AbortController();
      try {
        for await (const e of session.events({ after, signal: ac.signal })) {
          events.push(e);
          if (events.length >= limit || e.sequence >= lastSequence) break;
        }
      } finally {
        ac.abort();
      }
      return events;
    },
  );
}

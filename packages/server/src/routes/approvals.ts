import { ApprovalDecisionSchema } from '@uncage/protocol';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { idempotencyKey, parse, type RouteContext } from '../context.js';

const ListQuerySchema = z.object({ sessionId: z.string().min(1) });

export function approvalRoutes(app: FastifyInstance, { uncage }: RouteContext): void {
  app.get('/v1/approvals', (request) => {
    const { sessionId } = parse(ListQuerySchema, request.query);
    return uncage.approvals.list({ sessionId, pendingOnly: true });
  });

  app.post<{ Params: { id: string } }>('/v1/approvals/:id/decision', async (request) => {
    const key = idempotencyKey(request);
    const decision = parse(ApprovalDecisionSchema, request.body);
    return uncage.approvals.decide(request.params.id, decision, key);
  });
}

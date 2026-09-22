import { Router } from 'express';
import type { AgentIdentityService } from './identity.js';
import type { AgentSessionService } from './sessions.js';
import { exactFields, requireThat } from '../validation.js';

function cursor(value: unknown, fallback: number, max: number) {
  if (value === undefined) return fallback;
  requireThat(typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value) && Number(value) <= max,
    'INVALID_REQUEST', 'Invalid cursor or wait.');
  return Number(value);
}
export function agentSessionRoutes(identity: AgentIdentityService, sessions: AgentSessionService) {
  const router = Router();
  router.use(async (req, res, next) => {
    const token = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : '';
    res.locals.agentPrincipal = await identity.authenticate(token); next();
  });
  router.post('/', async (req, res) => {
    exactFields(req.query, []);
    const result = await sessions.open(res.locals.agentPrincipal, req.body);
    res.status(result.replay ? 200 : 201).json(result.body);
  });
  for (const action of ['accept', 'reject', 'close', 'stopped', 'messages'] as const) router.post(`/:id/${action}`, async (req, res) => {
    exactFields(req.query, []); const p = res.locals.agentPrincipal, id = req.params.id;
    if (action === 'messages') {
      const result = await sessions.send(p, id, req.body); res.status(result.replay ? 200 : 201).json(result.body);
    } else if (action === 'accept') res.json(await sessions.accept(p, id, req.body));
    else if (action === 'stopped') res.json(await sessions.stoppedAck(p, id, req.body));
    else res.json(await sessions.close(p, id, req.body, action === 'reject'));
  });
  for (const messages of [false, true]) router.get(messages ? '/:id/messages' : '/:id', async (req, res, next) => {
    const field = messages ? 'after' : 'after_version'; exactFields(req.query, [field, 'wait']);
    const after = cursor(req.query[field], 0, 2147483647), wait = cursor(req.query.wait, 20, 20);
    const controller = new AbortController(), disconnect = () => controller.abort(); res.once('close', disconnect);
    try {
      const result = await sessions.poll(res.locals.agentPrincipal, req.params.id, after, wait, messages, controller.signal);
      if (!controller.signal.aborted) res.json(result);
    } catch (error) { if (!controller.signal.aborted) next(error); }
    finally { res.off('close', disconnect); }
  });
  return router;
}

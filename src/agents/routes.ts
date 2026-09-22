import type { AgentPolicyService } from './policies.js';
import { Router } from 'express';
import { receiverReference, type ReceiverService } from './receivers.js';
import { exactFields, requireThat } from '../validation.js';
import { AGENT_FRIENDS_PROTOCOL as protocol } from './protocol.js';
import { type AgentIdentityService, identityPage } from './identity.js';

/** Mounted only behind the owner's session and write/CSRF guards. */
export function ownerAgentRoutes(service: AgentIdentityService, policies?: AgentPolicyService) {
  const router = Router();
  router.get('/', async (req, res) => res.json({ protocol, ...await service.list(res.locals.ownerId, identityPage(req.query)) }));
  router.post('/', async (req, res) => res.status(201).json({ protocol, agent: await service.create(res.locals.ownerId, req.body) }));
  router.get('/:id', async (req, res) => res.json({ protocol, agent: await service.get(res.locals.ownerId, req.params.id) }));
  router.patch('/:id', async (req, res) => res.json({ protocol, agent: await service.update(res.locals.ownerId, req.params.id, req.body) }));
  router.post('/:id/disable', async (req, res) => {
    exactFields(req.body ?? {}, []);
    res.json({ protocol, agent: await service.disable(res.locals.ownerId, req.params.id) });
  });
  router.get('/:id/credentials', async (req, res) => res.json({ protocol, ...await service.credentials(res.locals.ownerId, req.params.id, identityPage(req.query)) }));
  router.post('/:id/credentials', async (req, res) => {
    exactFields(req.body ?? {}, []);
    res.status(201).json({ protocol, ...await service.issueKey(res.locals.ownerId, req.params.id) });
  });
  router.post('/:id/credentials/:credentialId/rotate', async (req, res) => {
    exactFields(req.body ?? {}, []);
    res.status(201).json({ protocol, ...await service.rotateKey(res.locals.ownerId, req.params.id, req.params.credentialId) });
  });
  router.delete('/:id/credentials/:credentialId', async (req, res) => {
    exactFields(req.body ?? {}, []);
    res.json({ protocol, credential: await service.revokeKey(res.locals.ownerId, req.params.id, req.params.credentialId) });
  });
  if (policies) {
    router.get('/:id/peers', async (req, res) => res.json({ protocol, ...await policies.list(res.locals.ownerId, req.params.id, identityPage(req.query)) }));
    router.get('/:id/peers/:peerId', async (req, res) => {
      exactFields(req.query, []);
      res.json({ protocol, policy: await policies.get(res.locals.ownerId, req.params.id, req.params.peerId) });
    });
    router.put('/:id/peers/:peerId', async (req, res) => {
      exactFields(req.query, []);
      res.json({ protocol, policy: await policies.put(res.locals.ownerId, req.params.id, req.params.peerId, req.body) });
    });
    router.delete('/:id/peers/:peerId', async (req, res) => {
      exactFields(req.query, []); exactFields(req.body ?? {}, []);
      res.json({ protocol, ...await policies.delete(res.locals.ownerId, req.params.id, req.params.peerId) });
    });
  }
  return router;
}
export function runtimeIdentityRoutes(service: AgentIdentityService, receivers: ReceiverService) {
  const router = Router();
  router.use('/me/receiver', async (req, res, next) => {
    const token = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : '';
    res.locals.agentPrincipal = await service.authenticate(token);
    next();
  });
  router.post('/me/receiver', async (req, res) => {
    const result = await receivers.acquire(res.locals.agentPrincipal, req.body);
    res.status(result.replay ? 200 : 201).json(result.body);
  });
  router.post('/me/receiver/heartbeat', async (req, res) => res.json(await receivers.heartbeat(res.locals.agentPrincipal, req.body)));
  router.post('/me/receiver/release', async (req, res) => res.json(await receivers.release(res.locals.agentPrincipal, req.body)));
  router.get('/me/receiver/inbox', async (req, res, next) => {
    exactFields(req.query, ['lease_id', 'generation', 'wait']);
    const reference = receiverReference({ lease_id: req.query.lease_id, generation: req.query.generation });
    requireThat(req.query.wait === undefined || (typeof req.query.wait === 'string' && /^(?:[0-9]|1[0-9]|20)$/.test(req.query.wait)), 'INVALID_REQUEST', 'wait must be 0–20 seconds.');
    const controller = new AbortController(), disconnect = () => controller.abort();
    res.once('close', disconnect);
    try {
      const result = await receivers.inbox(res.locals.agentPrincipal, reference, Number(req.query.wait ?? 20), controller.signal);
      if (!controller.signal.aborted) res.json(result);
    } catch (error) { if (!controller.signal.aborted) next(error); }
    finally { res.off('close', disconnect); }
  });
  router.get('/me', async (req, res) => {
    exactFields(req.query, []);
    const token = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : '';
    const principal = await service.authenticate(token);
    res.json({ protocol, agent: { id: principal.agent_id, display_name: principal.display_name }, availability: await receivers.presence(principal.agent_id) });
  });
  return router;
}

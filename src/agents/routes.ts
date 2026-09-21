import { Router } from 'express';
import { exactFields } from '../validation.js';
import { AGENT_FRIENDS_PROTOCOL as protocol } from './protocol.js';
import { type AgentIdentityService, identityPage } from './identity.js';

/** Mounted only behind the owner's session and write/CSRF guards. */
export function ownerAgentRoutes(service: AgentIdentityService) {
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
  return router;
}
export function runtimeIdentityRoutes(service: AgentIdentityService) {
  const router = Router();
  router.get('/me', async (req, res) => {
    exactFields(req.query, []);
    const token = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : '';
    const principal = await service.authenticate(token);
    res.json({ protocol, agent: { id: principal.agent_id, display_name: principal.display_name } });
  });
  return router;
}

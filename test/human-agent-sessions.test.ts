import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentIdentityService } from '../src/agents/identity.js';
import { OwnerService } from '../src/owners/service.js';
import { requireThat, uuid } from '../src/validation.js';
import { fixture, waitUntil } from './helpers.js';
const origin = 'https://app.example';
async function setup() {
  const issuer = `https://${uuid()}.example`;
  const f = await fixture({ publicUrl: origin, ownerProvider: {
    async authorize() { throw new Error('unused'); }, async exchange() { throw new Error('unused'); },
    async authenticate(cookie) { requireThat(['a','b','c'].includes(cookie), 'OWNER_UNAUTHORIZED', 'Sign in.', 401); return { issuer, subject: cookie, sessionId: cookie, expiresAt: new Date(Date.now()+300000) }; },
    async logout() { return origin; },
  } });
  const owners = new OwnerService(f.db, f.auth, f.now), agents = new AgentIdentityService(f.db, f.auth, f.now);
  const oa = await owners.establish(issuer, 'a'), ob = await owners.establish(issuer, 'b'), oc = await owners.establish(issuer, 'c');
  const make = async (owner: string) => {
    const agent = await agents.create(owner, { display_name: 'Agent' }), key = await agents.issueKey(owner, agent.id), p = await agents.authenticate(key.api_key);
    return { id: agent.id, p, key, receiver: (await f.app.receivers.acquire(p, { connection_id: uuid(), takeover: false })).body.receiver, binding: uuid() };
  };
  const a = await make(oa.id), b = await make(ob.id);
  for (const [owner, left, right] of [[oa.id,a,b],[ob.id,b,a]] as const) await f.app.policies.put(owner,left.id,right.id,{allow_inbound:true,allow_outbound:true});
  const id = (await f.app.agentSessions.open(a.p,{receiver:a.receiver,recipient_agent_id:b.id,idempotency_key:uuid(),binding_id:a.binding})).body.session.id;
  const call = async (user: string, path: string, body?: unknown, extra: Record<string,string> = {}) => {
    const r = await fetch(`${f.base}/api/v1/owner/agent-sessions${path}`, {method:body === undefined ? 'GET' : 'POST',headers:{Cookie:`__Host-rv-owner=${user}`,Origin:origin,'X-CSRF-Token':owners.csrf(user),...(body === undefined ? {} : {'Content-Type':'application/json'}),...extra},...(body === undefined ? {} : {body:JSON.stringify(body)})});
    return {status:r.status,body:await r.json()};
  };
  return {...f,owners,oa,ob,oc,a,b,id,call,stop:async()=>{
    await f.app.close(); await f.db.query('DELETE FROM sessions WHERE id=$1',[id]);
    for(const who of [a,b]) {await f.db.query('DELETE FROM agent_receivers WHERE agent_id=$1',[who.id]); await f.db.query('DELETE FROM agent_connections WHERE agent_id=$1',[who.id]); await f.db.query('DELETE FROM agent_credentials WHERE agent_id=$1',[who.id]);}
    await f.db.query('DELETE FROM agents WHERE owner_id IN ($1,$2)',[oa.id,ob.id]); await f.db.query('DELETE FROM owners WHERE issuer=$1',[issuer]); await f.db.close();
  }};
}

test('either owner can discover, observe, speak and close; human and agent messages share one ordered log',async()=>{
  const f=await setup(); try {
    assert.equal(f.app.agentSessions.engine,f.service.engine);
    for(const user of ['a','b']) { assert.equal((await f.call(user,'')).body.sessions[0].id,f.id); assert.equal((await f.call(user,`/${f.id}`)).body.status,'PENDING'); }
    assert.equal((await f.call('a',`/${f.id}/messages`,{content:'Human context before acceptance'})).status,201);
    await f.app.agentSessions.accept(f.b.p,f.id,{receiver:f.b.receiver,binding_id:f.b.binding});
    await f.app.agentSessions.send(f.a.p,f.id,{receiver:f.a.receiver,client_message_id:uuid(),content:'Agent reply'});
    assert.equal((await f.call('b',`/${f.id}/messages`,{content:'Other owner response'})).status,201);
    const page=await f.app.agentSessions.poll(f.b.p,f.id,0,0,true);
    assert.ok('messages' in page && page.messages);
    assert.deepEqual(page.messages.map(m=>m.sequence),[1,2,3]);
    assert.deepEqual(page.messages.map(m=>m.sender_type),['human','agent','human']);
    assert.deepEqual(page.messages.map(m=>m.sender_agent_id),[null,f.a.id,null]);
    for(const user of ['a','b']) assert.equal((await f.call(user,`/${f.id}/messages?wait=0`)).body.messages.length,3);
    assert.equal((await f.db.query<{n:number}>('SELECT count(*)::integer AS n FROM agent_session_bindings WHERE session_id=$1',[f.id])).rows[0].n,2);
    assert.equal((await f.call('b',`/${f.id}/close`,{})).status,200);
    assert.equal((await f.app.receivers.heartbeat(f.a.p,{receiver:f.a.receiver,accepting_sessions:true})).sessions_to_stop[0],f.id);
    assert.equal((await f.call('a',`/${f.id}/messages`,{content:'Too late'})).status,409);
    assert.equal((await f.call('a',`/${f.id}/messages?wait=0`)).body.messages.length,3);
  }finally{await f.stop();}
});

test('owner room access enforces account ownership, CSRF, sender attribution and disabled accounts',async()=>{
  const f=await setup();try{
    assert.deepEqual((await f.call('c','')).body.sessions,[]);
    for(const [path,body] of [[`/${f.id}`,undefined],[`/${f.id}/messages?wait=0`,undefined],[`/${f.id}/messages`,{content:'intrusion'}],[`/${f.id}/close`,{}]] as const) assert.equal((await f.call('c',path,body)).status,404);
    assert.equal((await f.call('a',`/${f.id}`,undefined,{Cookie:'',Authorization:`Bearer ${f.a.key.api_key}`})).status,401);
    assert.equal((await f.call('a',`/${f.id}/messages`,{content:'bad csrf'},{'X-CSRF-Token':''})).status,403);
    assert.equal((await f.call('b',`/${f.id}/close`,{},{Origin:'https://evil.example'})).status,403);
    assert.equal((await f.call('a',`/${f.id}/messages`,{content:'forged',sender_owner_id:f.ob.id})).status,400);
    assert.equal((await f.call('a',`/${f.id}/messages`,{content:'forged',sender_agent_id:f.b.id})).status,400);
    await f.db.query('UPDATE owners SET disabled_at=now() WHERE id=$1',[f.oa.id]);
    assert.equal((await f.call('a',`/${f.id}`)).status,401);
    assert.equal((await f.call('b',`/${f.id}`)).status,200);
  }finally{await f.stop();}
});

test('human writes wake an agent poll and agent writes wake an owner poll through the shared engine',async()=>{
  const f=await setup();try{
    await f.app.agentSessions.accept(f.b.p,f.id,{receiver:f.b.receiver,binding_id:f.b.binding});
    const agent=f.app.agentSessions.poll(f.a.p,f.id,0,20,true);
    await waitUntil(()=>f.service.waiters.has(f.id));
    await f.call('b',`/${f.id}/messages`,{content:'Human message'});
    const received=await agent; assert.ok('messages' in received && received.messages); assert.equal(received.messages[0].content,'Human message');
    const human=f.call('a',`/${f.id}/messages?after=1&wait=20`);
    await waitUntil(()=>f.service.waiters.has(f.id));
    await f.app.agentSessions.send(f.b.p,f.id,{receiver:f.b.receiver,client_message_id:uuid(),content:'Agent message'});
    assert.equal((await human).body.messages[0].content,'Agent message');
    assert.equal(f.service.waiters.size,0);
  }finally{await f.stop();}
});

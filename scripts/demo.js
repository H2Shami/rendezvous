import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import assert from 'node:assert/strict';
import { Agent } from '../client/agent.js';
import { fixture } from '../test/helpers.js';

const dir = await mkdtemp(pathJoin(tmpdir(), 'rendezvous-demo-'));
const f = await fixture();
try {
  const room = await f.create();
  const invitation = `${f.base}/join/${room.session_id}#${room.invite_token}`;
  const alice = await Agent.connect(invitation, pathJoin(dir, 'alice.json'), 'Alice');
  const bob = await Agent.connect(invitation, pathJoin(dir, 'bob.json'), 'Bob');
  console.log('Two locally generated identities joined from the same fragment URL.');
  await alice.send({ text: 'When can your user hang out?' });
  await bob.read(row => console.log('Bob receives:', row.message.payload.text));
  await bob.send({ text: 'Thursday evening works. I will confirm with my user.' });
  await alice.read(row => console.log('Alice receives:', row.message.payload.text));
  console.log('Bob disconnects; Alice sends another message.');
  await alice.send({ text: 'How about 7:30?' });
  const returned = await Agent.load(pathJoin(dir, 'bob.json'));
  const received = [];
  await returned.read(row => { received.push(row); console.log('Bob replays:', row.message.payload.text); });
  assert.equal(received.at(-1).message.payload.text, 'How about 7:30?');
  assert.equal(returned.state.cursor, 3);
  console.log('PASS: signed two-client conversation and durable offline replay.');
} finally { await f.stop(); await rm(dir, { recursive: true, force: true }); }

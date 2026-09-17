import assert from 'node:assert/strict';
import { fixture } from '../test/helpers.js';
import { testClient } from '../test/http-client.js';

const f = await fixture();
try {
  const room = await f.create(); const url = `${f.base}/join/${room.session_id}#${room.invite_token}`;
  const a = await testClient(url, 'Alice'); const secondInvite = await f.service.invite(room.session_id, room.owner_token, {});
  const b = await testClient(`${f.base}/join/${room.session_id}#${secondInvite.invite_token}`, 'Bob');
  const waiting = b.poll(60);
  await a.send('Would Thursday at 7 work?'); console.log('Bob receives:', (await waiting).messages.at(-1).content);
  await b.send('I can do 7:30. Would that work for Alice?');
  console.log('Alice receives:', (await a.poll(60)).messages.at(-1).content);
  await a.send('7:30 works tentatively. I need approval before booking.');
  console.log('Bob reads later:', (await b.poll(0)).messages.at(-1).content);
  await b.send('Agreed tentatively. I will also ask for approval.');
  assert.match((await a.poll(60)).messages.at(-1).content, /Agreed tentatively/);
  await a.leave(); await b.leave();
  console.log('PASS: plain HTTP admission, long polling, multi-turn coordination, late reads and leave.');
} finally { await f.stop(); }

const $ = s => document.querySelector(s);
let session, owner, invite, timer, cursor = 0, sending = false;
async function api(path = '', method = 'GET', body) {
  const response = await fetch(`/api/v1/sessions${session ? `/${session}` : ''}${path}`, { method,
    headers: { 'Content-Type': 'application/json', ...(owner ? { Authorization: `Bearer ${owner}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await response.json(); if (!response.ok) throw new Error(`${value.error.code}: ${value.error.message}`); return value;
}
function error(e) { $('#error').textContent = e.message; }
function element(tag, text, cls) { const el = document.createElement(tag); el.textContent = text; if (cls) el.className = cls; return el; }
async function refresh() {
  try {
    const info = await api(); $('#status').textContent = info.status;
    $('#expiry').textContent = `Expires ${new Date(info.expires_at).toLocaleString()}`;
    $('#participant-count').textContent = `${info.participants.filter(p => !p.left_at && !p.revoked_at).length}/${info.max_participants}`;
    $('#participants').replaceChildren();
    for (const p of info.participants) {
      const name = p.display_name || p.id.slice(0, 8);
      const el = element('div', '', 'participant'); el.append(element('strong', name), element('small', `${p.id.slice(0, 8)} · self-reported${p.revoked_at ? ' · revoked' : p.left_at ? ' · left' : ''}`));
      if (!p.revoked_at && !p.left_at) { const b = element('button', 'Revoke'); b.onclick = () => api(`/participants/${p.id}`, 'DELETE').then(refresh).catch(error); el.append(b); }
      $('#participants').append(el);
    }
    $('#invites').replaceChildren();
    for (const i of info.invites || []) {
      const el = element('div', '', 'invite'); el.append(element('small', `${i.id.slice(0, 8)} · ${i.use_count}/${i.max_uses} used${i.revoked_at ? ' · revoked' : ''}`));
      if (!i.revoked_at) { const b = element('button', 'Revoke'); b.onclick = () => api(`/invites/${i.id}`, 'DELETE').then(refresh).catch(error); el.append(b); }
      $('#invites').append(el);
    }
    $('#close-session').disabled = ['CLOSED', 'EXPIRED'].includes(info.status); $('#new-invite').disabled = ['CLOSED', 'EXPIRED'].includes(info.status);
    $('#send-message').disabled = sending || ['CLOSED', 'EXPIRED'].includes(info.status);
    $('#message-content').disabled = ['CLOSED', 'EXPIRED'].includes(info.status);
    $('#error').textContent = '';
  } catch (e) { error(e); }
  clearTimeout(timer); timer = setTimeout(refresh, 2000);
}
function enter() {
  $('#create').hidden = true; $('#room').hidden = false;
  $('#session-title').textContent = `Room ${session.slice(0, 8)}`;
  $('#invite-url').value = invite || 'Create a new invite below if you no longer have the original.';
  $('#copy-invite').disabled = !invite;
  refresh();
  receive();
}
$('#create-form').onsubmit = async e => {
  e.preventDefault(); const button = e.currentTarget.querySelector('button'); button.disabled = true;
  try { const out = await api('', 'POST', { max_participants: Number($('#capacity').value) }); session = out.session_id; owner = out.owner_token; invite = out.invite_url; history.replaceState(null, '', `/#${session}.${owner}`); enter(); }
  catch (e) { error(e); } finally { button.disabled = false; }
};
$('#copy-invite').onclick = () => navigator.clipboard.writeText(`Join this rendezvous: ${invite}\nFetch ${invite.split('#')[0]} with an ordinary HTTP GET for the full participation instructions (curl is fine; no browser needed). Keep the full invitation above, including its #fragment, for joining. Follow the returned instructions to coordinate on my task.`).then(() => { $('#copy-invite').textContent = 'Copied'; }).catch(error);
$('#message-form').onsubmit = async e => {
  e.preventDefault(); const input = $('#message-content'); const button = $('#send-message');
  if (sending || !input.value.trim()) return;
  sending = true; button.disabled = true;
  try { await api('/messages', 'POST', { content: input.value }); input.value = ''; $('#send-error').textContent = ''; }
  catch (e) { $('#send-error').textContent = e.message; }
  finally { sending = false; button.disabled = input.disabled; }
};
$('#new-invite').onclick = async () => { try { const out = await api('/invites', 'POST', { max_uses: 1 }); invite = out.invite_url; $('#invite-url').value = invite; $('#copy-invite').disabled = false; await refresh(); } catch (e) { error(e); } };
$('#close-session').onclick = () => api('/close', 'POST', {}).then(refresh).catch(error);
const match = location.hash.match(/^#([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/i);
if (match) { [, session, owner] = match; enter(); }

async function receive() {
  while (true) {
    try {
      const page = await api(`/messages?after=${cursor}&wait=60`);
      if (cursor === 0 && page.messages.length) $('#messages').replaceChildren();
      for (const message of page.messages) {
        const el = element('article', '', 'message');
        el.append(element('small', `${message.sender_id === 'owner' ? 'Owner' : message.sender_id.slice(0, 8)} · #${message.sequence}`), element('pre', message.content));
        $('#messages').append(el);
      }
      cursor = page.cursor;
      if (['closed', 'expired'].includes(page.session_status) && !page.messages.length) break;
    } catch (e) { error(e); break; }
  }
}

// Deterministic test helper, not an end-user SDK. Only standard HTTP/fetch.
export async function testClient(invitation: string, displayName: string) {
  const url = new URL(invitation);
  const metadataResponse = await fetch(invitation, { headers: { Accept: 'application/json' } });
  const bootstrap = await metadataResponse.json();
  const response = await fetch(bootstrap.endpoints.join, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ invite_token: url.hash.slice(1), display_name: displayName }) });
  const membership = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(membership));
  const headers = { Authorization: `Bearer ${membership.participant_token}`, 'Content-Type': 'application/json' };
  let cursor: number = membership.cursor;
  async function request(url: string, options: RequestInit = {}) {
    const response = await fetch(url, { ...options, headers });
    const body = await response.json();
    if (!response.ok) throw new Error(JSON.stringify(body)); return body;
  }
  return { membership, bootstrap, get cursor() { return cursor; },
    send: (content: string) => request(membership.endpoints.messages, { method: 'POST', body: JSON.stringify({ content }) }),
    poll: async (wait = 60, signal?: AbortSignal) => {
      const page = await request(`${membership.endpoints.messages}?after=${cursor}&wait=${wait}`, { signal }); cursor = page.cursor; return page;
    },
    leave: () => request(membership.endpoints.leave, { method: 'POST', body: '{}' }),
  };
}

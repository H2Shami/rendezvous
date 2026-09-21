export interface AccountSession { owner: { id: string }; expires_at: string; csrf_token: string }
export async function accountSession(signal?: AbortSignal): Promise<AccountSession | null> {
  const response = await fetch('/api/v1/owner/me', { credentials: 'same-origin', cache: 'no-store', signal });
  if (response.status === 401) return null;
  if (!response.ok) throw new Error('Unable to load your account. Please try again.');
  return response.json();
}
export async function signOut(csrfToken: string): Promise<string> {
  const response = await fetch('/api/v1/owner/logout', {
    method: 'POST', credentials: 'same-origin', cache: 'no-store',
    headers: { 'X-CSRF-Token': csrfToken },
  });
  if (response.status === 401) return '/account';
  if (!response.ok) throw new Error('Unable to sign out. Reload the page and try again.');
  return (await response.json()).logout_url;
}

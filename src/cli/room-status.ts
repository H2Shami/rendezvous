import { HttpError, parseInvitation, RoomClient } from './client.js';
import type { LocalRoom } from './config.js';

export interface RoomStatus { state: string; usable: boolean; detail: string }
/** Local room records are history, not proof a server still has a usable room. */
export async function roomStatus(room: LocalRoom): Promise<RoomStatus> {
  try {
    const invitation = parseInvitation(room.invite_url);
    const fragment = new URL(room.owner_url).hash.slice(1);
    const prefix = `${room.session_id}.`;
    const token = fragment.startsWith(prefix) ? fragment.slice(prefix.length) : '';
    if (!token) throw new Error('Missing owner credential');
    const live = await new RoomClient(invitation.origin, room.session_id, token).inspect(AbortSignal.timeout(5000));
    const state = live.status.toLowerCase();
    return { state, usable: state === 'waiting' || state === 'active', detail: `${state} · expires ${live.expires_at}` };
  } catch (error) {
    const state = error instanceof HttpError ? ({ 404: 'unavailable', 410: 'expired', 401: 'access denied', 403: 'access denied' } as Record<number, string>)[error.status] : undefined;
    return { state: state ?? 'unverified', usable: false, detail: state ? `${state} on this server` : 'Could not refresh from server · reopen to retry' };
  }
}

import { identityColor } from "../lib/identity";
import type { Room } from "../lib/api";

interface RoomMembersProps {
  room: Room | null;
  disabled: boolean;
  readOnly?: boolean;
  onRevokeParticipant: (id: string) => void;
  onRevokeInvite: (id: string) => void;
  onCreateInvite: () => void;
}

export default function RoomMembers({
  room,
  disabled,
  readOnly = false,
  onRevokeParticipant,
  onRevokeInvite,
  onCreateInvite,
}: RoomMembersProps) {
  return (
    <section>
      <h2>
        Participants{" "}
        <span id="participant-count">
          {room &&
            `${room.participants.filter((p) => !p.left_at && !p.revoked_at).length}/${room.max_participants}`}
        </span>
      </h2>
      <div id="participants">
        {room?.participants.map((p) => (
          <div className="participant" key={p.id}>
            <strong style={{ color: identityColor(p.id) }}>{p.display_name?.trim() || `Agent ${p.id.slice(0, 8)}`}</strong>
            <small>
              {p.id.slice(0, 8)} · self-reported
              {p.revoked_at ? " · revoked" : p.left_at ? " · left" : ""}
            </small>
            {!readOnly && !p.revoked_at && !p.left_at && (
              <button
                disabled={disabled}
                onClick={() => onRevokeParticipant(p.id)}
              >
                Revoke
              </button>
            )}
          </div>
        ))}
      </div>
      {!readOnly && <>
      <h2>Invitations</h2>
      <div id="invites">
        {room?.invites?.map((i) => (
          <div className="invite" key={i.id}>
            <small>
              {i.id.slice(0, 8)} · {i.use_count}/{i.max_uses} used
              {i.revoked_at ? " · revoked" : ""}
            </small>
            {!i.revoked_at && (
              <button disabled={disabled} onClick={() => onRevokeInvite(i.id)}>
                Revoke
              </button>
            )}
          </div>
        ))}
      </div>
      <button
        id="new-invite"
        className="secondary"
        disabled={!room || disabled}
        onClick={onCreateInvite}
      >
        Create invite
      </button>
      <p className="muted">Each invite can be shared up to its use limit.</p>
      </>}
    </section>
  );
}

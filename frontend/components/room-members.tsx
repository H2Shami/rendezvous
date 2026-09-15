import type { Room } from "../lib/api";

interface RoomMembersProps {
  room: Room | null;
  disabled: boolean;
  onRevokeParticipant: (id: string) => void;
  onRevokeInvite: (id: string) => void;
  onCreateInvite: () => void;
}

export default function RoomMembers({
  room,
  disabled,
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
            <strong>{p.display_name || p.id.slice(0, 8)}</strong>
            <small>
              {p.id.slice(0, 8)} · self-reported
              {p.revoked_at ? " · revoked" : p.left_at ? " · left" : ""}
            </small>
            {!p.revoked_at && !p.left_at && (
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
        Create single-use invite
      </button>
      <p className="muted">A replacement invite admits one agent only.</p>
    </section>
  );
}

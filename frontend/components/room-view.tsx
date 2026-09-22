"use client";
import RoomMembers from "./room-members";
import { useRef, useState } from "react";
import {
  createInvite,
  closeSession,
  revokeParticipant,
  revokeInvite,
  invitationText,
  type Owner,
} from "../lib/api";
import Conversation from "./conversation";
import { useRoom } from "../hooks/use-room";
import { errorText, isTerminal } from "../lib/room";

export default function RoomView({
  owner,
  invite,
  inviteId,
  setInvite,
}: {
  owner: Owner;
  invite: string;
  inviteId: string;
  setInvite: (value: string, id: string) => void;
}) {
  const { room, messages, error, setError, pollError, refresh } =
    useRoom(owner);
  const [mutating, setMutating] = useState(false);
  const [copied, setCopied] = useState(false);
  const actionInFlight = useRef(false);
  const ended = isTerminal(room?.status);
  const full = !!room &&
    room.participants.filter(p => !p.left_at && !p.revoked_at).length >= room.max_participants;
  const currentInvite = room?.invites?.find(i => i.id === inviteId);
  const consumed = !!currentInvite && currentInvite.use_count >= currentInvite.max_uses;
  const unavailable = consumed || !!currentInvite?.revoked_at;
  const canCopy = !!invite && !unavailable && !ended && !full && !mutating;

  async function runRoomAction(action: () => Promise<unknown>) {
    if (actionInFlight.current) return;
    actionInFlight.current = true;
    setMutating(true);
    setError("");
    try {
      await action();
      await refresh();
    } catch (e) {
      setError(errorText(e));
    } finally {
      actionInFlight.current = false;
      setMutating(false);
    }
  }
  async function newInvite() {
    await runRoomAction(async () => {
      const result = await createInvite(owner);
      setInvite(result.invite_url, result.invite_id);
      setCopied(false);
    });
  }
  async function copy() {
    if (!canCopy) return;
    try {
      await navigator.clipboard.writeText(invitationText(invite));
      setCopied(true);
    } catch (e) {
      setError(errorText(e));
    }
  }
  return (
    <section id="room">
      <div className="room-heading">
        <div>
          <p className="eyebrow">YOUR SESSION</p>
          <h1 id="session-title">Room {owner.session.slice(0, 8)}</h1>
        </div>
        <span id="status" className="badge">
          {room?.status || "LOADING"}
        </span>
      </div>
      <p id="expiry" className="muted">
        {room && `Expires ${new Date(room.expires_at).toLocaleString()}`}
      </p>
      {!owner.account && <>
      <div className="invite-panel">
        <div>
          <strong>Invite your agents</strong>
          <p>
            Copy an invitation with the link and HTTP instruction-fetching
            directions. Share the same link with your agents until its uses run out.
            Give each agent its task too.
          </p>
        </div>
        <button id="copy-invite" disabled={!canCopy} onClick={copy}>
          {copied ? "Copied" : "Copy invite"}
        </button>
      </div>
      <input
        id="invite-url"
        aria-label="Invitation URL"
        readOnly
        value={
          invite || "Create a new invite below if you no longer have the original."
        }
      />
      <p id="invite-usage" className="muted" aria-live="polite">
        {currentInvite && `Used ${currentInvite.use_count} of ${currentInvite.max_uses} times`}
        {currentInvite?.revoked_at ? " · Revoked" : consumed ? " · Exhausted — create a new invite below" : full ? " · Room is full" : ""}
      </p>
      <p className="muted">
        Save this owner page’s full URL privately. It grants access to
        participant information, messaging and room controls.
      </p>
      </>}
      {owner.account && <p className="muted">Both agents’ owners can observe, speak, and close this session. Trusted agents may start conversations automatically.</p>}
      <div className="columns">
        <RoomMembers
          room={room}
          readOnly={owner.account}
          disabled={mutating || ended}
          onRevokeParticipant={(id) =>
            runRoomAction(() => revokeParticipant(owner, id))
          }
          onRevokeInvite={(id) => runRoomAction(() => revokeInvite(owner, id))}
          onCreateInvite={newInvite}
        />
        <Conversation
          owner={owner}
          messages={messages}
          participants={room?.participants ?? []}
          disabled={!room || ended}
          pollError={pollError}
        />
      </div>
      <button
        id="close-session"
        className="danger"
        disabled={!room || ended || mutating}
        onClick={() => runRoomAction(() => closeSession(owner))}
      >
        Close session
      </button>
      <p id="error" role="alert">
        {error}
      </p>
    </section>
  );
}

"use client";
import RoomMembers from "./room-members";
import { useState } from "react";
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
  setInvite,
}: {
  owner: Owner;
  invite: string;
  setInvite: (value: string) => void;
}) {
  const { room, messages, error, setError, pollError, refresh } =
    useRoom(owner);
  const [mutating, setMutating] = useState(false);
  const [copied, setCopied] = useState(false);
  async function runRoomAction(action: () => Promise<unknown>) {
    if (mutating) return;
    setMutating(true);
    setError("");
    try {
      await action();
      await refresh();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setMutating(false);
    }
  }
  async function newInvite() {
    await runRoomAction(async () => {
      const result = await createInvite(owner);
      setInvite(result.invite_url);
      setCopied(false);
    });
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(invitationText(invite));
      setCopied(true);
    } catch (e) {
      setError(errorText(e));
    }
  }
  const ended = isTerminal(room?.status);
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
      <div className="invite-panel">
        <div>
          <strong>Invite your agents</strong>
          <p>
            Copy an invitation with the link and HTTP instruction-fetching
            directions. Each link admits one agent. Create a new invite below for
            each additional agent, and give each agent its task too.
          </p>
        </div>
        <button id="copy-invite" disabled={!invite} onClick={copy}>
          {copied ? "Copied" : "Copy invite"}
        </button>
      </div>
      <input
        id="invite-url"
        aria-label="Invitation URL"
        readOnly
        value={
          invite ||
          "Create a new invite below if you no longer have the original."
        }
      />
      <p className="muted">
        Save this owner page’s full URL privately. It grants access to
        participant information, messaging and room controls.
      </p>
      <div className="columns">
        <RoomMembers
          room={room}
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

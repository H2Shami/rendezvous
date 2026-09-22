"use client";

import { useEffect, useState } from "react";
import type { Owner } from "../lib/api";
import { parseOwnerFragment } from "../lib/owner-url";
import { useInvitation } from "./app-shell";
import { accountSession } from "../lib/owner-auth";
import RoomView from "./room-view";

export default function RoomPage({ sessionId }: { sessionId: string }) {
  const [owner, setOwner] = useState<Owner | null>(null);
  const [ready, setReady] = useState(false);
  const { invitation, setInvitation } = useInvitation();

  useEffect(() => {
    const abort = new AbortController();
    async function restoreOwner() {
      const credential = parseOwnerFragment(location.hash);
      if (credential?.session === sessionId) setOwner(credential);
      else {
        try {
          const account = await accountSession(abort.signal);
          if (abort.signal.aborted) return;
          setOwner(account ? { session: sessionId, token: '', account: true, csrfToken: account.csrf_token } : null);
        } catch { if (abort.signal.aborted) return; setOwner(null); }
      }
      setReady(true);
    }
    restoreOwner();
    window.addEventListener("hashchange", restoreOwner);
    return () => { abort.abort(); window.removeEventListener("hashchange", restoreOwner); };
  }, [sessionId]);

  if (!ready) return <p>Loading…</p>;
  if (!owner || owner.session !== sessionId)
    return (
      <p role="alert">
        Open the full owner link, including its #fragment, to access this room.
        For an agent session, <a href="/account">sign in as an agent’s owner</a> and open the room from your account.
      </p>
    );
  return (
    <RoomView
      key={`${owner.session}.${owner.token}`}
      owner={owner}
      invite={invitation?.session === sessionId ? invitation.url : ""}
      inviteId={invitation?.session === sessionId ? invitation.id : ""}
      setInvite={(url, id) => setInvitation({ session: sessionId, url, id })}
    />
  );
}

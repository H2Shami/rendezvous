"use client";

import { useEffect, useState } from "react";
import type { Owner } from "../lib/api";
import { parseOwnerFragment } from "../lib/owner-url";
import { useInvitation } from "./app-shell";
import RoomView from "./room-view";

export default function RoomPage({ sessionId }: { sessionId: string }) {
  const [owner, setOwner] = useState<Owner | null>(null);
  const [ready, setReady] = useState(false);
  const { invitation, setInvitation } = useInvitation();

  useEffect(() => {
    function restoreOwner() {
      const credential = parseOwnerFragment(location.hash);
      setOwner(credential?.session === sessionId ? credential : null);
      setReady(true);
    }
    restoreOwner();
    window.addEventListener("hashchange", restoreOwner);
    return () => window.removeEventListener("hashchange", restoreOwner);
  }, [sessionId]);

  if (!ready) return <p>Loading…</p>;
  if (!owner || owner.session !== sessionId)
    return (
      <p role="alert">
        Open the full owner link, including its #fragment, to access this room.
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

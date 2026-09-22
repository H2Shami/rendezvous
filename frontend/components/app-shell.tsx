"use client";

import { createContext, useContext, useState, type ReactNode } from "react";
import LightTrails from "./light-trails";

// Keep the current invitation and its ID in memory across navigation, never in browser storage.
const InvitationContext = createContext<{
  invitation: { session: string; url: string; id: string } | null;
  setInvitation: (invitation: { session: string; url: string; id: string }) => void;
} | null>(null);

export function useInvitation() {
  const context = useContext(InvitationContext);
  if (!context) throw new Error("Invitation context requires AppShell");
  return context;
}

export default function AppShell({ children }: { children: ReactNode }) {
  const [invitation, setInvitation] = useState<{
    session: string;
    url: string;
    id: string;
  } | null>(null);
  return (
    <InvitationContext.Provider value={{ invitation, setInvitation }}>
      <LightTrails />
      <main>
        <header>
          <a href="/" className="brand">
            <span className="brand-mark" aria-hidden="true">⟋⟋</span> rendezvous
          </a>
          <nav aria-label="Main navigation"><span className="tag">AGENT TO AGENT / V1</span><a className="nav-link" href="/settings/agents">Agents</a><a className="nav-link" href="/account">Account</a><a className="nav-link" href="/protocol/v1">Protocol ↗</a></nav>
        </header>
        {children}
        <footer>
          <a href="/protocol/v1">Read the integration guide</a>
          <span>Server-readable history · Self-reported names</span>
        </footer>
      </main>
    </InvitationContext.Provider>
  );
}

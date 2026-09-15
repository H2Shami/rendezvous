"use client";

import { createContext, useContext, useState, type ReactNode } from "react";

// Keep the initial invitation in memory across navigation, never in browser storage.
const InvitationContext = createContext<{
  invitation: { session: string; url: string } | null;
  setInvitation: (invitation: { session: string; url: string }) => void;
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
  } | null>(null);
  return (
    <InvitationContext.Provider value={{ invitation, setInvitation }}>
      <main>
        <header>
          <a href="/" className="brand">
            ◎ Rendezvous
          </a>
          <span className="tag">AGENT COMMUNICATION / V1</span>
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

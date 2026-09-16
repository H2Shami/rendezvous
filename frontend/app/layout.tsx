import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import AppShell from "../components/app-shell";
import localFont from "next/font/local";

const displayFont = localFont({
  src: "./fonts/orbitron.ttf",
  variable: "--font-display",
  display: "swap",
  weight: "400 900",
});

export const metadata: Metadata = {
  title: "Rendezvous",
  description: "A shared place for your agents to coordinate.",
};
export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={displayFont.variable}>
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}

import type { Participant } from "./api";

// Identity (not a mutable display name) determines the color across refreshes.
export function identityColor(id: string): string {
  if (id === "owner") return "#f5c77e";
  let hash = 0;
  for (const char of id) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0;
  return `hsl(${hash % 360} 65% 75%)`;
}
export function identityName(id: string, participants: Participant[]): string {
  if (id === "owner") return "Owner";
  return participants.find(p => p.id === id)?.display_name?.trim() || `Agent ${id.slice(0, 8)}`;
}

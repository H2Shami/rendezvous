import type { Owner } from "./api";

export function parseOwnerFragment(fragment: string): Owner | null {
  const match = fragment.match(/^#([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/i);
  return match ? { session: match[1], token: match[2] } : null;
}

export function ownerPageUrl(owner: Owner): string {
  return `/rooms/${owner.session}#${owner.session}.${owner.token}`;
}

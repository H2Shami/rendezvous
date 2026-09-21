import { one, type Database } from '../db.js';
import type { Security } from '../security.js';
import { requireThat, secret, uuid } from '../validation.js';

export const LOGIN_MS = 10 * 60 * 1000;
export interface OwnerPrincipal { id: string }

export class OwnerService {
  constructor(readonly db: Database, private auth: Security, private clock = Date.now) {}
  private digest(purpose: string, value: string) { return this.auth.digest(`owner:${purpose}:${value}`); }
  async beginLogin(flow = 'workos') {
    const state = secret(), browser = secret();
    await this.db.query('INSERT INTO owner_login_attempts(state_hash,browser_hash,expires_at,flow) VALUES($1,$2,$3,$4)',
      [this.digest('state', state), this.digest('browser', browser), new Date(this.clock() + LOGIN_MS), flow]);
    return { state, browser, ...this.checks(browser) };
  }
  checks(browser: string) {
    return { verifier: this.digest('pkce', browser) };
  }
  async consumeLogin(state: string, browser: string, flow = 'workos') {
    requireThat(state.length === 43 && browser.length === 43, 'LOGIN_INVALID', 'Sign-in expired or invalid. Please start again.', 400);
    // Consume once, atomically; a wrong browser cannot consume the real attempt.
    const row = await one(this.db,
      'DELETE FROM owner_login_attempts WHERE state_hash=$1 AND browser_hash=$2 AND expires_at>$3 AND flow=$4 RETURNING state_hash',
      [this.digest('state', state), this.digest('browser', browser), new Date(this.clock()), flow]);
    requireThat(row, 'LOGIN_INVALID', 'Sign-in expired or invalid. Please start again.', 400);
    return this.checks(browser);
  }
  async establish(issuer: string, subject: string): Promise<OwnerPrincipal> {
    // Identity comes only from WorkOS; matching email is never proof of ownership.
    const owner = await one<{ id: string; disabled_at: Date | null }>(this.db,
      `INSERT INTO owners(id,issuer,subject) VALUES($1,$2,$3)
       ON CONFLICT(issuer,subject) DO UPDATE SET subject=EXCLUDED.subject RETURNING id,disabled_at`,
      [uuid(), issuer, subject]);
    requireThat(owner && !owner.disabled_at, 'OWNER_DISABLED', 'Account is disabled.', 403);
    return { id: owner.id };
  }
  async authenticate(issuer: string, subject: string): Promise<OwnerPrincipal> {
    const owner = await one<OwnerPrincipal>(this.db,
      'SELECT id FROM owners WHERE issuer=$1 AND subject=$2 AND disabled_at IS NULL', [issuer, subject]);
    requireThat(owner, 'OWNER_UNAUTHORIZED', 'Sign in to continue.', 401);
    return owner;
  }
  csrf(token: string) { return this.digest('csrf', token); }
  checkCsrf(token: string, supplied: string) {
    requireThat(this.auth.matches(`owner:csrf:${token}`, supplied), 'CSRF_INVALID', 'Reload the page and try again.', 403);
  }
  /** Call after loading a resource, or prefer WHERE owner_id=principal.id in SQL. */
  requireOwnership(principal: OwnerPrincipal, resourceOwnerId: string) {
    requireThat(principal.id === resourceOwnerId, 'NOT_FOUND', 'Resource not found.', 404);
  }
  async cleanup() {
    await this.db.query('DELETE FROM owner_login_attempts WHERE expires_at<=$1', [new Date(this.clock())]);
  }
}

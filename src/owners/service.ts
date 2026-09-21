import { one, type Database } from '../db.js';
import type { Security } from '../security.js';
import { requireThat, secret, uuid } from '../validation.js';

export const OWNER_SESSION_MS = 7 * 24 * 60 * 60 * 1000;
export const LOGIN_MS = 10 * 60 * 1000;
export interface OwnerPrincipal { id: string; session_id: string; expires_at: Date }

export class OwnerService {
  constructor(readonly db: Database, private auth: Security, private clock = Date.now) {}
  private digest(purpose: string, value: string) { return this.auth.digest(`owner:${purpose}:${value}`); }
  async beginLogin(flow = 'cognito') {
    const state = secret(), browser = secret();
    await this.db.query('INSERT INTO owner_login_attempts(state_hash,browser_hash,expires_at,flow) VALUES($1,$2,$3,$4)',
      [this.digest('state', state), this.digest('browser', browser), new Date(this.clock() + LOGIN_MS), flow]);
    return { state, browser, ...this.checks(browser) };
  }
  checks(browser: string) {
    return { verifier: this.digest('pkce', browser), nonce: this.digest('nonce', browser) };
  }
  async consumeLogin(state: string, browser: string, flow = 'cognito') {
    requireThat(state.length === 43 && browser.length === 43, 'LOGIN_INVALID', 'Sign-in expired or invalid. Please start again.', 400);
    // Consume once, atomically; a wrong browser cannot consume the real attempt.
    const row = await one(this.db,
      'DELETE FROM owner_login_attempts WHERE state_hash=$1 AND browser_hash=$2 AND expires_at>$3 AND flow=$4 RETURNING state_hash',
      [this.digest('state', state), this.digest('browser', browser), new Date(this.clock()), flow]);
    requireThat(row, 'LOGIN_INVALID', 'Sign-in expired or invalid. Please start again.', 400);
    return this.checks(browser);
  }
  async establish(issuer: string, subject: string, previousToken = '') {
    requireThat(issuer.length > 0 && subject.length > 0 && subject.length <= 1024, 'LOGIN_INVALID', 'Invalid sign-in identity.', 400);
    const token = secret(), sessionId = uuid(), now = new Date(this.clock());
    const expires = new Date(this.clock() + OWNER_SESSION_MS);
    const ownerId = await this.db.transaction(async tx => {
      // Same email is intentionally irrelevant; the provider's stable issuer/sub is identity.
      const owner = await one<{ id: string; disabled_at: Date | null }>(tx,
        `INSERT INTO owners(id,issuer,subject) VALUES($1,$2,$3)
         ON CONFLICT(issuer,subject) DO UPDATE SET subject=EXCLUDED.subject RETURNING id,disabled_at`,
        [uuid(), issuer, subject]);
      requireThat(owner && !owner.disabled_at, 'OWNER_DISABLED', 'Account is disabled.', 403);
      if (previousToken) await tx.query('UPDATE owner_sessions SET revoked_at=$1 WHERE token_hash=$2 AND revoked_at IS NULL',
        [now, this.digest('session', previousToken)]);
      await tx.query('INSERT INTO owner_sessions(id,owner_id,token_hash,created_at,expires_at) VALUES($1,$2,$3,$4,$5)',
        [sessionId, owner.id, this.digest('session', token), now, expires]);
      return owner.id;
    });
    return { token, ownerId, expires };
  }
  async authenticate(token: string): Promise<OwnerPrincipal> {
    requireThat(/^[A-Za-z0-9_-]{43}$/.test(token), 'OWNER_UNAUTHORIZED', 'Sign in to continue.', 401);
    const owner = await one<OwnerPrincipal>(this.db,
      `SELECT o.id,s.id AS session_id,s.expires_at FROM owner_sessions s JOIN owners o ON o.id=s.owner_id
       WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>$2 AND o.disabled_at IS NULL`,
      [this.digest('session', token), new Date(this.clock())]);
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
  async revoke(token: string) {
    await this.db.query('UPDATE owner_sessions SET revoked_at=$1 WHERE token_hash=$2 AND revoked_at IS NULL',
      [new Date(this.clock()), this.digest('session', token)]);
  }
  async cleanup() {
    await this.db.query('DELETE FROM owner_login_attempts WHERE expires_at<=$1', [new Date(this.clock())]);
    await this.db.query('DELETE FROM owner_sessions WHERE expires_at<=$1 OR revoked_at IS NOT NULL', [new Date(this.clock())]);
  }
}

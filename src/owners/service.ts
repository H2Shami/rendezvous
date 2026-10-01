import { type Database } from "../db.js";
import { and, eq, gt, isNull, lte } from "drizzle-orm";
import { owners, ownerLoginAttempts as attempts } from "../schema.js";
import type { Security } from "../security.js";
import { requireThat, secret, uuid } from "../validation.js";

export const LOGIN_MS = 10 * 60 * 1000;
export interface OwnerPrincipal {
  id: string;
}

export class OwnerService {
  constructor(
    readonly db: Database,
    private auth: Security,
    private clock = Date.now,
  ) {}
  private digest(purpose: string, value: string) {
    return this.auth.digest(`owner:${purpose}:${value}`);
  }
  async beginLogin(flow = "workos") {
    const state = secret(),
      browser = secret();
    await this.db.orm
      .insert(attempts)
      .values({
        state_hash: this.digest("state", state),
        browser_hash: this.digest("browser", browser),
        expires_at: new Date(this.clock() + LOGIN_MS),
        flow,
      });
    return { state, browser, ...this.checks(browser) };
  }
  checks(browser: string) {
    return { verifier: this.digest("pkce", browser) };
  }
  async consumeLogin(state: string, browser: string, flow = "workos") {
    requireThat(
      state.length === 43 && browser.length === 43,
      "LOGIN_INVALID",
      "Sign-in expired or invalid. Please start again.",
      400,
    );
    // Consume once, atomically; a wrong browser cannot consume the real attempt.
    const [row] = await this.db.orm
      .delete(attempts)
      .where(
        and(
          eq(attempts.state_hash, this.digest("state", state)),
          eq(attempts.browser_hash, this.digest("browser", browser)),
          gt(attempts.expires_at, new Date(this.clock())),
          eq(attempts.flow, flow),
        ),
      )
      .returning({ state_hash: attempts.state_hash });
    requireThat(
      row,
      "LOGIN_INVALID",
      "Sign-in expired or invalid. Please start again.",
      400,
    );
    return this.checks(browser);
  }
  async establish(issuer: string, subject: string): Promise<OwnerPrincipal> {
    // Identity comes only from WorkOS; matching email is never proof of ownership.
    const [owner] = await this.db.orm
      .insert(owners)
      .values({ id: uuid(), issuer, subject })
      .onConflictDoUpdate({
        target: [owners.issuer, owners.subject],
        set: { subject },
      })
      .returning({ id: owners.id, disabled_at: owners.disabled_at });
    requireThat(
      owner && !owner.disabled_at,
      "OWNER_DISABLED",
      "Account is disabled.",
      403,
    );
    return { id: owner.id };
  }
  async authenticate(issuer: string, subject: string): Promise<OwnerPrincipal> {
    const [owner] = await this.db.orm
      .select({ id: owners.id })
      .from(owners)
      .where(
        and(
          eq(owners.issuer, issuer),
          eq(owners.subject, subject),
          isNull(owners.disabled_at),
        ),
      );
    requireThat(owner, "OWNER_UNAUTHORIZED", "Sign in to continue.", 401);
    return owner;
  }
  csrf(token: string) {
    return this.digest("csrf", token);
  }
  checkCsrf(token: string, supplied: string) {
    requireThat(
      this.auth.matches(`owner:csrf:${token}`, supplied),
      "CSRF_INVALID",
      "Reload the page and try again.",
      403,
    );
  }
  /** Call after loading a resource, or prefer WHERE owner_id=principal.id in SQL. */
  requireOwnership(principal: OwnerPrincipal, resourceOwnerId: string) {
    requireThat(
      principal.id === resourceOwnerId,
      "NOT_FOUND",
      "Resource not found.",
      404,
    );
  }
  async cleanup() {
    await this.db.orm
      .delete(attempts)
      .where(lte(attempts.expires_at, new Date(this.clock())));
  }
}

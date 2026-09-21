ALTER TABLE owner_sessions ADD COLUMN IF NOT EXISTS provider_session_id text;
ALTER TABLE owner_login_attempts ALTER COLUMN flow SET DEFAULT 'workos';
-- Retire legacy authentication without deleting owners or anything they own.
-- Idempotent: existing migrations are intentionally reapplied at startup.
UPDATE owner_sessions s SET revoked_at=now()
FROM owners o WHERE s.owner_id=o.id AND s.revoked_at IS NULL
AND (o.issuer='https://github.com' OR o.issuer LIKE 'https://cognito-idp.%');
DELETE FROM owner_login_attempts WHERE flow IN ('cognito','github');

-- REN-6 is unmerged: fresh installs never create app sessions. Retire the
-- ephemeral session table on databases that ran earlier revisions of this PR.
-- Owner records and their data remain intact; old browser cookies require login.
DROP TABLE IF EXISTS owner_sessions;
ALTER TABLE owner_login_attempts ALTER COLUMN flow SET DEFAULT 'workos';
DELETE FROM owner_login_attempts WHERE flow IN ('cognito','github');

ALTER TABLE owner_login_attempts ADD COLUMN IF NOT EXISTS flow text NOT NULL DEFAULT 'cognito';

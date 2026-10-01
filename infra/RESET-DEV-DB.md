# Reset dev for the Drizzle baseline

This is an **intentional, destructive dev-only reset without a new backup**.
It removes all app data (owners, rooms, agents, credentials, messages and leases)
and migration history. Existing automated RDS backups are not removed. Production
is not part of this procedure. RDS, its password, `TOKEN_PEPPER`, networking and
`DATABASE_URL` stay unchanged.

Pulumi controls the service lifecycle; an explicit SQL command resets the schemas.
No reset runs automatically during `pulumi up`. Use the Drizzle PR checkout for
both deployments below. Do not resume the old application after clearing data.

## 1. Pause dev through Pulumi

From the repository root, with Docker running and AWS/Pulumi authenticated:

```sh
cd infra
npm ci
npm run check
pulumi config set devServicePaused true --stack dev
pulumi preview --stack dev
pulumi up --stack dev
```

Inspect the preview before approving: the ECS service must change to zero tasks;
there must be no RDS replacement/deletion or unrelated infrastructure changes.
Pulumi builds the new images here but leaves the service stopped. The maintenance
setting defaults to false and is rejected on any stack other than `dev`.

Confirm desired, running and pending counts are **all zero** before continuing:

```sh
aws --profile "$(pulumi config get aws:profile --stack dev)" \
  --region "$(pulumi config get aws:region --stack dev)" ecs describe-services \
  --cluster "$(pulumi stack output clusterName --stack dev)" \
  --services "$(pulumi stack output serviceName --stack dev)" \
  --query 'services[].{desired:desiredCount,running:runningCount,pending:pendingCount}'
```

Also stop any local backend/listener connected to the remote dev database. Keep
the service paused if any subsequent step fails; do not resume automatically.

## 2. Open the private dev tunnel

In a second terminal, from the repository root:

```sh
PULUMI_STACK=dev npm --prefix infra run db:tunnel
```

Keep this terminal open. Use the default local port 15432. If that port is already
occupied, stop and identify the listener rather than reusing an unknown tunnel.
See [database access](DB-ACCESS.md) for prerequisites and password access.

## 3. Connect, inspect, then reset explicitly

In the first terminal (still in `infra/`):

```sh
curl --fail --location https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem \
  --output /tmp/rendezvous-rds-ca.pem
pulumi stack output databaseHost --stack dev
psql "host=$(pulumi stack output databaseHost --stack dev) hostaddr=127.0.0.1 port=15432 dbname=rendezvous user=rendezvous sslmode=verify-full sslrootcert=/tmp/rendezvous-rds-ca.pem" \
  -X -W -v ON_ERROR_STOP=1
```

Enter the **dev** database password at the prompt (do not put it in shell history).
The connection verifies TLS against the dev RDS hostname, not localhost. Inside
psql, inspect before running the destructive block:

```sql
\conninfo
SELECT current_database(), current_user;
SELECT pid, usename, application_name, state
FROM pg_stat_activity
WHERE datname = current_database() AND pid <> pg_backend_pid();
```

Confirm the hostname matches the dev output, the database/user are `rendezvous`,
and no application connections remain. Close other clients first. Then run:

```sql
BEGIN;
SET LOCAL lock_timeout = '5s';
DROP SCHEMA IF EXISTS drizzle CASCADE;
DROP SCHEMA public CASCADE;
CREATE SCHEMA public AUTHORIZATION rendezvous;
COMMIT;
\q
```

This permanently removes the application schemas and data, including both legacy
and Drizzle migration ledgers. It does not drop the database or RDS instance. If
SQL fails, exit psql (or `ROLLBACK`) and resolve the problem while dev stays paused.
The transaction prevents a partially committed schema reset.

## 4. Resume the Drizzle application through Pulumi

From `infra/`, using the same Drizzle checkout:

```sh
pulumi config set devServicePaused false --stack dev
pulumi preview --stack dev
pulumi up --stack dev
curl --fail "$(pulumi stack output url --stack dev)/health"
```

Pulumi restores one task. Backend startup applies `drizzle/0000_initial.sql` before
the frontend becomes healthy. Log in again, create a room and new agent credentials,
then verify join, send, long polling and listener reconnect. Old keys and links
will no longer work. A healthy `/health` alone is not a full functional check.

After closing the tunnel with Ctrl+C, from the repository root:

```sh
PULUMI_STACK=dev npm --prefix infra run db:tunnel:stop
```

Do not commit a temporary `devServicePaused: true` stack setting. If rollout fails,
pause dev again and inspect backend logs using the stack's `logGroupName` output.
There is no data rollback in this procedure; fix forward on the Drizzle version.

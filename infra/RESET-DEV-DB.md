# Recreate the dev database

Open the private dev tunnel in one terminal, then run the reset in another (both
from the repository root):

```sh
# Terminal 1: leave running
PULUMI_STACK=dev npm --prefix infra run db:tunnel

# Terminal 2: one command handles pause → recreate → resume
npm --prefix infra run db:reset:dev
```

This **permanently deletes and recreates the dev `rendezvous` database**, without
taking a new backup. Production, the RDS instance, credentials, networking and
existing automated backups are untouched. Old rooms, agent keys and links stop
working. This is an explicit operator command, never a normal `pulumi up` action.

## Prerequisites

- Use the Drizzle checkout with a reviewed infra diff. Install project/infra
  dependencies, Docker, Pulumi, AWS CLI, Session Manager plugin and `psql`.
  Authenticate AWS and Pulumi; Docker must be running for image builds.
- The dev stack must already have its database tunnel enabled. The helper always
  selects stack `dev` and checks the actual RDS endpoint and AWS
  `Project=rendezvous`, `Stack=dev` tags. It accepts no target arguments.
- Close other clients connected to the hosted dev database. Use tunnel port 15432
  or the same `DB_LOCAL_PORT` override in both terminals. See [DB access](DB-ACCESS.md).
- Have the dev database password ready. Enter it in the `psql` password prompt,
  not a command or shell history. There are two prompts: a read-only connection
  preflight before pausing ECS, and the actual reset after ECS stops.

## What happens

1. Verify the dev RDS identity and tunnel connection with full TLS hostname checks.
2. Display the exact RDS hostname and require typing `delete dev rendezvous`.
3. Set `devServicePaused=true` and run `pulumi up --stack dev`. Review and approve
   the plan: ECS goes to zero tasks; no RDS replacement or unrelated changes.
4. Verify ECS desired/running/pending counts are zero and recheck RDS identity.
5. Connect to the maintenance database `postgres` and run `DROP DATABASE IF EXISTS
   rendezvous`, followed by `CREATE DATABASE rendezvous OWNER rendezvous TEMPLATE
   template0`. No forced disconnections: active database clients cause failure.
6. Set `devServicePaused=false` and run Pulumi again. Approve this second plan;
   the Drizzle backend starts and creates the new tables automatically.
7. Check `/health`. Sign in, create new agent credentials and a room, then test
   joining, sending, long polling and reconnecting.

Close the tunnel with Ctrl+C when done. When nobody else needs the bridge:

```sh
npm --prefix infra run db:tunnel:stop
```

## If it fails

The command stops immediately; it never resumes after a failed drop/create.
Drop and create are separate operations, **not an atomic transaction**. A create
failure can leave the database absent. Fix the reported error and rerun the reset
command only if you still intend to discard all dev data. `IF EXISTS` permits
recovery from an absent database. Interrupting a reset also requires checking
the database and ECS state before continuing.

If failure occurs during resume or health verification, the service may already
be running. To pause it again, from `infra/`:

```sh
pulumi config set devServicePaused true --stack dev
pulumi up --stack dev
```

For an application-only failure after successful recreation, fix forward on the
Drizzle version, then set `devServicePaused=false` and run Pulumi again; do not
reset a second time unnecessarily. Do not commit a temporary paused stack setting.
There is no data rollback in this no-backup workflow. Never resume the legacy app.

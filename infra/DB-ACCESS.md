# Private dev database access

The dev stack enables `enableDbTunnel`: a small `t4g.nano` Amazon Linux 2023
instance with Session Manager, no inbound security-group rules, and no SSH key.
It has a public IP only for outbound HTTPS access to AWS; PostgreSQL egress is
limited to the database subnets. RDS accepts PostgreSQL from the bridge's
security group. The bridge role has SSM permissions, not database credentials
or Secrets Manager access. IAM users opening sessions still need SSM session
permissions; starting/stopping the bridge additionally requires EC2 permissions.

## Open a tunnel

Install AWS's [Session Manager plugin for your OS](https://docs.aws.amazon.com/systems-manager/latest/userguide/install-plugin-macos-overview.html).
Then, from the repository root:

```sh
aws login --profile rendezvous  # if the current session has expired
npm --prefix infra run db:tunnel
```

The helper reads the dev stack outputs, starts the bridge if stopped, waits for
SSM, and forwards local port **15432** to RDS port **5432**. Keep it running while
using the database. `DB_LOCAL_PORT=15433` overrides the local port;
`PULUMI_STACK` defaults to `dev`. Never bind this tunnel to a public interface.

For DBeaver, select PostgreSQL and use:

| Field | Value |
| --- | --- |
| Host | localhost |
| Port | 15432 |
| Database | rendezvous |
| User | rendezvous |
| Password | Password from the dev Secrets Manager `DATABASE_URL` |

Do not enable DBeaver's SSH tunnel: Session Manager already provides the tunnel.
Download the RDS CA bundle from
https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem and configure it
as the root certificate. For a client connecting to `localhost`, SSL mode
`verify-ca` checks the RDS certificate chain but not its hostname; the authenticated
SSM session selects the remote host. Do not disable certificate checking or use
a nonvalidating SSL factory. For full hostname verification, use a client that
can separate its connection address from its TLS hostname, as below.

## psql with full TLS verification

From `infra/`, after saving the CA bundle to `/tmp/rendezvous-rds-ca.pem`:

```sh
psql "host=$(pulumi stack output databaseHost --stack dev) hostaddr=127.0.0.1 port=15432 dbname=rendezvous user=rendezvous sslmode=verify-full sslrootcert=/tmp/rendezvous-rds-ca.pem" -W
```

This connects to the local tunnel while verifying the certificate against the
actual RDS hostname. Enter the database password at the prompt, rather than
placing it in shell history. The existing user owns the database; use a separate
read-only PostgreSQL role if you only need to inspect data.

## Close and stop

Press Ctrl+C in the tunnel terminal, then:

```sh
npm --prefix infra run db:tunnel:stop
```

Closing the session alone does not stop EC2. Stopping the instance interrupts
other users' tunnels too. EC2 compute and its auto-assigned public IPv4 are billed
while running; the encrypted 8 GiB disk remains billable when stopped. The helper
starts it again on the next use. Stopping does not affect the app or RDS.

The AMI is pinned in state after initial creation via `ignoreChanges`; plan
maintenance or an explicit bridge replacement to refresh the OS over time.
Session Manager can audit session start/stop events, but port-forwarded query
contents are not captured in Session Manager logs.

# AWS deployment with Pulumi

This stack runs Next.js and one Express relay together on ECS Fargate, behind an
HTTPS Application Load Balancer. PostgreSQL runs on private Amazon RDS with
encrypted storage, automated backups, deletion protection, and a final
snapshot on intentional deletion. The default region is **us-west-2 (Oregon)**.
Production uses **userendezvous.com**; development uses **dev.userendezvous.com**.
Each stack must explicitly configure its hostname to avoid DNS collisions.

## Development and production

Both stacks use the same infrastructure program with separate Pulumi state and
separate VPCs, RDS databases, generated secrets, ECS services, ECR repositories,
load balancers, and certificates. They share the existing Route 53 hosted zone,
but manage different DNS records. No production data is copied into development.

| Setting | dev | prod |
| --- | --- | --- |
| Domain | dev.userendezvous.com | userendezvous.com |
| Region | us-west-2 | us-west-2 |
| RDS | db.t4g.micro, single-AZ | db.t4g.micro, single-AZ |
| Database storage | 20 GiB, no growth | 20 GiB, grows up to 100 GiB |
| Automated backup retention | 1 day | 7 days |
| Container log retention | 7 days | 30 days |
| App task | 0.5 vCPU / 1 GiB, one replica | 0.5 vCPU / 1 GiB, one replica |

Dev remains publicly accessible and has the same deletion protections as prod.
It incurs its own always-on RDS, load balancer, and Fargate charges; shorter
retention does not eliminate that baseline cost. At the dev storage limit,
writes can fail rather than automatically provisioning more storage.

To register and deploy dev after completing the prerequisites below:

```sh
cd infra
npm ci
pulumi login
pulumi stack init dev  # first time only; otherwise: pulumi stack select dev
npm run check
pulumi preview --stack dev
pulumi up --stack dev
```

The committed `Pulumi.dev.yaml` provides its settings. Use `--stack dev` or
`--stack prod` explicitly on preview/update commands to avoid targeting the
wrong environment. The production hostname is rejected for non-prod stacks.
Dev selects the local AWS profile `rendezvous`; authenticate with
`aws login --profile rendezvous` before deployment. If you use a different
profile, set `pulumi config set aws:profile YOUR_PROFILE --stack dev`.
An AWS Organizations service control policy can still deny operations even
after login succeeds; the organization administrator must resolve those
restrictions or identify an approved account and region before deployment.

RDS for PostgreSQL is the AWS equivalent of Cloud SQL for PostgreSQL. Start with
single-AZ RDS and enable `multiAz` when you need database failover. This is a
production-oriented foundation, not a highly available application: relay
notifications are process-local, so ECS runs exactly one task and stops the old
task before starting its replacement. Deployments cause a short interruption.

## Prerequisites

- Node 22+, Docker with a running daemon, [Pulumi CLI](https://www.pulumi.com/docs/install/),
  and AWS credentials for your intended account.
- A domain/subdomain. With a Route 53 public hosted zone, Pulumi handles DNS and
  certificate validation. Otherwise obtain an **issued ACM certificate in
  us-west-2** covering your hostname, and set its ARN below.
- A Pulumi state backend. `pulumi login` uses Pulumi Cloud; an existing managed
  backend also works. Restrict access to state: it includes encrypted secrets.
- Verify the account with `aws sts get-caller-identity` before provisioning.
  The deployment identity needs permissions for VPC, ECS, ECR, RDS, IAM,
  Secrets Manager, CloudWatch, ELB, and optionally ACM/Route 53.

## Configure and deploy

`Pulumi.prod.yaml` contains the production domain, region, and Route 53 hosted
zone ID. Register the `prod` stack in your selected state backend with
`pulumi stack init prod` on first use; use `pulumi stack select prod` thereafter.
The configuration commands below are for overriding these settings or creating
another stack.

```sh
cd infra
npm ci
pulumi login
pulumi stack init prod
pulumi config set aws:region us-west-2
pulumi config set domain userendezvous.com

# Choose one certificate/DNS approach:
pulumi config set hostedZoneId Z02297441UMB16BS5O67U
# OR, for DNS hosted elsewhere:
# pulumi config set certificateArn arn:aws:acm:us-west-2:ACCOUNT:certificate/ID

# Optional settings (defaults shown):
pulumi config set dbInstanceClass db.t4g.micro
pulumi config set multiAz false

npm run check
pulumi preview
pulumi up
```

Pulumi creates the infrastructure, builds Linux amd64 Docker images locally,
pushes them to private ECR repositories, and deploys image digests to ECS. Run
from `infra/` so build paths resolve correctly. Docker must support amd64 builds
on Apple Silicon. AWS account/region capacity and quotas are checked during apply.

For external DNS, point a CNAME for your subdomain at the `loadBalancerHostname`
stack output. For an apex domain, your DNS provider needs ALIAS/ANAME support.
Route 53 configuration creates an alias automatically. Remove stale AAAA records.
The certificate must match the configured domain and be in the deployment region.

```sh
curl --fail "$(pulumi stack output url)/health"
```

Then create a room in the browser and verify join, send, and a 60-second poll.
The load balancer allows 120-second idle connections. `/health` checks the
frontend proxy, relay, and database but does not exercise every user flow.

## Updates and secrets

Run `pulumi preview` and `pulumi up` from `infra/` after source changes. The backend
automatically applies database migrations at startup. Take a manual RDS snapshot
before schema upgrades and check migration compatibility before rolling back.

Database credentials and a stable `TOKEN_PEPPER` are generated by Pulumi and
injected from Secrets Manager only into Express. Next.js receives neither.
Without `TOKEN_PEPPER`, local development continues using `server-secrets.json`.
Keep the production pepper for the lifetime of the database: changing it
invalidates existing tokens. Changing a secret requires a new ECS deployment to
load its value; secret rotation is not automatically configured.

This creates an empty database. Existing local or Cloud SQL data is not migrated.
If migrating existing Rendezvous rooms, preserve their original pepper as well
as the DB, and adapt the stack's secret value before switching traffic.

## Networking and costs

The database sits in isolated subnets without public access. Tasks use public
subnets with public IPs for outbound access to ECR, logs, and Secrets Manager;
their security group accepts only frontend traffic from the load balancer.
Express binds to loopback inside the task. There is no SSH port. This avoids a
NAT gateway; move tasks to private subnets with NAT or VPC endpoints if your
network requirements call for it.

Budget for always-on Fargate (0.5 vCPU / 1 GiB), the load balancer, RDS instance
and storage, public IPv4 addresses, logs, secrets, ECR storage, DNS, backups, and
traffic. Check the [AWS pricing calculator](https://calculator.aws/) before apply;
this managed setup costs more than a single VPS. Multi-AZ adds database cost.
ECR images are retained for rollback and require eventual cleanup.

## Operations and recovery

Container logs are retained for 30 days in prod and seven in dev. Inspect them using the `logGroupName`
output; ECS cluster/service and RDS identifiers are also exported. Set up uptime
and error alerts, database capacity alarms, and a billing budget before launch.
The initial app uses the database owner so startup migrations work; separate
migration/runtime DB roles are a later hardening step.

RDS automated backups support point-in-time recovery within the retention window.
Restoration creates a new database: restore, update/reconcile Pulumi state and the
connection secret, redeploy the task, then verify rooms and tokens. Keep the
original pepper. Test restoration before relying on the backup policy. This
stack does not create cross-region backups or automated disaster-recovery drills.

RDS, the generated credentials, and Secrets Manager secret are protected by
Pulumi; RDS also has AWS deletion protection. Do not remove these protections
without a backup and recovery plan. Intentional teardown requires disabling
deletion protection, applying, removing Pulumi protection, and then destroying.
Final snapshot names must be unique if you previously used the same name. ECR
repositories must be emptied before deletion. Retained snapshots/backups can
continue to incur charges.

References: [RDS automated backups](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_WorkingWithAutomatedBackups.html),
[RDS TLS certificates](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/UsingWithRDS.SSL.html).

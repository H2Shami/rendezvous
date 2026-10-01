import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, delimiter } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function assertDevTarget(outputs, instance, tags) {
  if (!outputs.dbTunnelInstanceId || !outputs.clusterName || !outputs.serviceName) throw new Error('Missing dev stack outputs/tunnel.');
  if (!/^[a-z0-9.-]+\.rds\.amazonaws\.com$/.test(outputs.databaseHost || '')) throw new Error('Invalid RDS hostname.');
  if (instance.DBInstanceIdentifier !== outputs.databaseIdentifier || instance.Endpoint?.Address !== outputs.databaseHost || instance.Engine !== 'postgres') {
    throw new Error('RDS instance does not match the dev stack.');
  }
  if (!tags.some(t => t.Key === 'Stack' && t.Value === 'dev') || !tags.some(t => t.Key === 'Project' && t.Value === 'rendezvous')) {
    throw new Error('Refusing database without rendezvous/dev AWS tags.');
  }
}

export function assertStopped(result) {
  const service = result.services?.[0];
  if (result.failures?.length || result.services?.length !== 1 || !service ||
      service.desiredCount !== 0 || service.runningCount !== 0 || service.pendingCount !== 0) {
    throw new Error('Dev ECS must have zero desired, running and pending tasks before reset.');
  }
}

export function resetSqlArgs() {
  // Separate requests: PostgreSQL forbids DROP/CREATE DATABASE in a transaction.
  // No FORCE: unexpected active clients must cause the reset to stop.
  return ['-c', 'DROP DATABASE IF EXISTS rendezvous;', '-c', 'CREATE DATABASE rendezvous OWNER rendezvous TEMPLATE template0;'];
}

export async function resetDev(workflow) {
  await workflow.confirm();
  await workflow.pause();
  await workflow.verifyStopped();
  await workflow.recreate();
  await workflow.resume();
  await workflow.health();
}

async function main() {
  if (process.argv.length > 2 || (process.env.PULUMI_STACK && process.env.PULUMI_STACK !== 'dev')) {
    throw new Error('This command accepts no arguments and only targets the dev stack.');
  }
  if (!process.stdin.isTTY) throw new Error('Run interactively: typed confirmation and a database password are required.');
  process.chdir(fileURLToPath(new URL('.', import.meta.url)));
  process.env.PATH += `${delimiter}${join(homedir(), '.local', 'bin')}`;
  function run(command, args, interactive = false, extraEnv = {}) {
    const result = spawnSync(command, args, { encoding: 'utf8',
      env: { ...process.env, ...extraEnv }, stdio: interactive ? 'inherit' : ['ignore', 'pipe', 'inherit'] });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${command} failed (${result.status})`);
    return result.stdout?.trim();
  }
  const pulumi = args => run('pulumi', [...args, '--stack', 'dev']);
  run('psql', ['--version']);
  const config = JSON.parse(pulumi(['config', '--json']));
  const outputs = JSON.parse(pulumi(['stack', 'output', '--json']));
  const profile = process.env.AWS_PROFILE || config['aws:profile']?.value;
  const aws = args => JSON.parse(run('aws', ['--region', config['aws:region'].value,
    ...(profile ? ['--profile', profile] : []), ...args, '--output', 'json']));
  function verifyTarget() {
    const instance = aws(['rds', 'describe-db-instances', '--db-instance-identifier', outputs.databaseIdentifier]).DBInstances?.[0];
    if (!instance) throw new Error('Dev RDS instance not found.');
    const tags = aws(['rds', 'list-tags-for-resource', '--resource-name', instance.DBInstanceArn]).TagList;
    assertDevTarget(outputs, instance, tags);
  }
  verifyTarget();
  const port = process.env.DB_LOCAL_PORT || '15432';
  if (!/^\d+$/.test(port) || +port < 1024 || +port > 65535) throw new Error('Invalid DB_LOCAL_PORT.');
  const temp = await mkdtemp(join(tmpdir(), 'rendezvous-dev-reset-'));
  let phase = 'preflight';
  try {
    const ca = join(temp, 'rds-ca.pem');
    run('curl', ['--fail', '--silent', '--show-error', '--max-time', '30',
      'https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem', '--output', ca]);
    // The tunnel must already be open; TLS authenticates the exact dev RDS hostname.
    // Use postgres, not the database being dropped. Never pass the password on argv.
    const connection = `host=${outputs.databaseHost} hostaddr=127.0.0.1 port=${port} dbname=postgres user=rendezvous sslmode=verify-full sslrootcert=${ca} connect_timeout=10`;
    const psql = args => run('psql', [connection, '-X', '-W', '-v', 'ON_ERROR_STOP=1', ...args], true,
      { PGOPTIONS: '-c statement_timeout=30000 -c lock_timeout=5000', PGPASSWORD: '' });
    console.log('Checking the private dev tunnel. Enter the dev DB password (you will be prompted again for the reset).');
    psql(['-c', 'SELECT current_database(), current_user;']);
    await resetDev({
      async confirm() {
        console.log(`DEV ONLY: permanently erase database rendezvous on ${outputs.databaseHost}.\nNo new backup. RDS infrastructure and credentials remain. Stop other dev database clients first.`);
        const input = createInterface({ input: process.stdin, output: process.stdout });
        try {
          if (await input.question('Type "delete dev rendezvous" to proceed: ') !== 'delete dev rendezvous') throw new Error('Cancelled; nothing changed.');
        } finally { input.close(); }
      },
      async pause() {
        phase = 'paused/resetting';
        pulumi(['config', 'set', 'devServicePaused', 'true']);
        console.log('Review the Pulumi plan: zero ECS tasks, no RDS replacement or unrelated changes.');
        run('pulumi', ['up', '--stack', 'dev'], true);
      },
      async verifyStopped() {
        verifyTarget();
        assertStopped(aws(['ecs', 'describe-services', '--cluster', outputs.clusterName, '--services', outputs.serviceName]));
      },
      async recreate() { psql(resetSqlArgs()); },
      async resume() {
        phase = 'resuming';
        pulumi(['config', 'set', 'devServicePaused', 'false']);
        run('pulumi', ['up', '--stack', 'dev'], true);
      },
      async health() {
        run('curl', ['--fail', '--show-error', '--max-time', '30', `${outputs.url}/health`], true);
        console.log('\nDev reset complete. Sign in and create new rooms/agent credentials.');
      },
    });
  } catch (error) {
    console.error(`Stopped during ${phase}. No automatic recovery or data rollback. See RESET-DEV-DB.md.`);
    throw error;
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}

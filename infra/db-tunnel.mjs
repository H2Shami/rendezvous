import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

process.chdir(fileURLToPath(new URL('.', import.meta.url)));
process.env.PATH = `${process.env.PATH || ''}${delimiter}${join(homedir(), '.local', 'bin')}`;
const stack = process.env.PULUMI_STACK || 'dev';
const stop = process.argv.includes('--stop');
const localPort = process.env.DB_LOCAL_PORT || '15432';
if (!/^\d+$/.test(localPort) || Number(localPort) < 1024 || Number(localPort) > 65535) {
  throw new Error('DB_LOCAL_PORT must be between 1024 and 65535');
}
function run(command, args, inherit = false) {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'inherit'] });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status})`);
  return result.stdout?.trim();
}
const outputs = JSON.parse(run('pulumi', ['stack', 'output', '--stack', stack, '--json']));
if (!outputs.dbTunnelInstanceId) throw new Error(`Enable and deploy enableDbTunnel on stack ${stack} first`);
const config = JSON.parse(run('pulumi', ['config', '--stack', stack, '--json']));
const region = config['aws:region'].value;
const profile = process.env.AWS_PROFILE || config['aws:profile']?.value;
const base = ['--region', region, ...(profile ? ['--profile', profile] : [])];
const aws = (args, inherit = false) => run('aws', [...base, ...args], inherit);
const instance = outputs.dbTunnelInstanceId;
if (stop) {
  aws(['ec2', 'stop-instances', '--instance-ids', instance, '--query', 'StoppingInstances[].CurrentState.Name', '--output', 'text'], true);
  process.exit(0);
}
const plugin = spawnSync('session-manager-plugin', ['--version'], { stdio: 'ignore' });
if (plugin.error || plugin.status !== 0) throw new Error('Install the AWS Session Manager plugin first; see infra/README.md');
const state = aws(['ec2', 'describe-instances', '--instance-ids', instance, '--query', 'Reservations[0].Instances[0].State.Name', '--output', 'text']);
if (state === 'stopping') aws(['ec2', 'wait', 'instance-stopped', '--instance-ids', instance]);
if (state === 'stopped' || state === 'stopping') aws(['ec2', 'start-instances', '--instance-ids', instance]);
aws(['ec2', 'wait', 'instance-running', '--instance-ids', instance]);
for (let attempt = 0; ; attempt++) {
  const status = aws(['ssm', 'describe-instance-information', '--filters', `Key=InstanceIds,Values=${instance}`, '--query', 'InstanceInformationList[0].PingStatus', '--output', 'text']);
  if (status === 'Online') break;
  if (attempt >= 59) throw new Error('SSM did not become ready within five minutes');
  await new Promise(resolve => setTimeout(resolve, 5000));
}
console.log(`Forwarding localhost:${localPort} to ${outputs.databaseHost}:5432. Keep this terminal open.`);
console.log('After closing the tunnel, stop the instance with: npm --prefix infra run db:tunnel:stop');
aws(['ssm', 'start-session', '--target', instance,
  '--document-name', 'AWS-StartPortForwardingSessionToRemoteHost',
  '--parameters', JSON.stringify({ host: [outputs.databaseHost], portNumber: ['5432'], localPortNumber: [localPort] }),
], true);

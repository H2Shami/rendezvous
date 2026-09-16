import * as aws from '@pulumi/aws';
import * as docker from '@pulumi/docker';
import * as pulumi from '@pulumi/pulumi';
import * as random from '@pulumi/random';

const config = new pulumi.Config();
const domain = config.require('domain');
if (pulumi.getStack() !== 'prod' && domain.toLowerCase() === 'userendezvous.com') {
  throw new Error('Only the prod stack may manage userendezvous.com; use a separate subdomain for other stacks');
}
const dbMaxAllocatedStorage = config.getNumber('dbMaxAllocatedStorage') ?? 100;
const dbBackupRetentionDays = config.getNumber('dbBackupRetentionDays') ?? 7;
const logRetentionDays = config.getNumber('logRetentionDays') ?? 30;
if (!Number.isInteger(dbMaxAllocatedStorage) || (dbMaxAllocatedStorage !== 0 && dbMaxAllocatedStorage < 22)) {
  throw new Error('dbMaxAllocatedStorage must be 0 to disable autoscaling or at least 22 GiB');
}
if (!Number.isInteger(dbBackupRetentionDays) || dbBackupRetentionDays < 1 || dbBackupRetentionDays > 35) {
  throw new Error('dbBackupRetentionDays must be an integer between 1 and 35');
}
if (![1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365].includes(logRetentionDays)) {
  throw new Error('logRetentionDays must be a supported CloudWatch retention period');
}
if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(domain)) {
  throw new Error('domain must be a DNS hostname without a scheme or path');
}
const zoneId = config.get('hostedZoneId');
const suppliedCertificate = config.get('certificateArn');
if (!zoneId && !suppliedCertificate) {
  throw new Error('Set hostedZoneId for automatic ACM/DNS, or certificateArn for an issued regional ACM certificate');
}
const region = aws.getRegionOutput().name;
const tags = { Project: pulumi.getProject(), Stack: pulumi.getStack() };
const vpc = new aws.ec2.Vpc('vpc', {
  cidrBlock: '10.42.0.0/16', enableDnsHostnames: true, enableDnsSupport: true, tags,
});
const gateway = new aws.ec2.InternetGateway('gateway', { vpcId: vpc.id, tags });
const publicRoutes = new aws.ec2.RouteTable('public-routes', {
  vpcId: vpc.id, routes: [{ cidrBlock: '0.0.0.0/0', gatewayId: gateway.id }], tags,
});
const zones = aws.getAvailabilityZonesOutput({ state: 'available' }).names;
const publicSubnets = [0, 1].map(i => {
  const subnet = new aws.ec2.Subnet(`public-${i}`, {
    vpcId: vpc.id, cidrBlock: `10.42.${i}.0/24`, availabilityZone: zones.apply(z => z[i]), tags,
  });
  new aws.ec2.RouteTableAssociation(`public-route-${i}`, { subnetId: subnet.id, routeTableId: publicRoutes.id });
  return subnet;
});
const privateRoutes = new aws.ec2.RouteTable('database-routes', { vpcId: vpc.id, tags });
const dbSubnets = [0, 1].map(i => {
  const subnet = new aws.ec2.Subnet(`database-${i}`, {
    vpcId: vpc.id, cidrBlock: `10.42.${i + 10}.0/24`, availabilityZone: zones.apply(z => z[i]), tags,
  });
  new aws.ec2.RouteTableAssociation(`database-route-${i}`, { subnetId: subnet.id, routeTableId: privateRoutes.id });
  return subnet;
});
const albSg = new aws.ec2.SecurityGroup('load-balancer-sg', {
  vpcId: vpc.id,
  ingress: [80, 443].map(port => ({ protocol: 'tcp', fromPort: port, toPort: port, cidrBlocks: ['0.0.0.0/0'] })),
  egress: [{ protocol: '-1', fromPort: 0, toPort: 0, cidrBlocks: ['0.0.0.0/0'] }], tags,
});
const taskSg = new aws.ec2.SecurityGroup('task-sg', {
  vpcId: vpc.id,
  ingress: [{ protocol: 'tcp', fromPort: 3000, toPort: 3000, securityGroups: [albSg.id] }],
  egress: [{ protocol: '-1', fromPort: 0, toPort: 0, cidrBlocks: ['0.0.0.0/0'] }], tags,
});
const dbSg = new aws.ec2.SecurityGroup('database-sg', {
  vpcId: vpc.id,
  ingress: [{ protocol: 'tcp', fromPort: 5432, toPort: 5432, securityGroups: [taskSg.id] }], tags,
});
const subnetGroup = new aws.rds.SubnetGroup('database-subnets', { subnetIds: dbSubnets.map(s => s.id), tags });
const password = new random.RandomPassword('database-password', { length: 40, special: false }, { protect: true });
const pepper = new random.RandomPassword('token-pepper', { length: 64, special: false }, { protect: true });
const database = new aws.rds.Instance('database', {
  engine: 'postgres', engineVersion: '17',
  instanceClass: config.get('dbInstanceClass') ?? 'db.t4g.micro',
  allocatedStorage: 20, maxAllocatedStorage: dbMaxAllocatedStorage, storageType: 'gp3', storageEncrypted: true,
  dbName: 'rendezvous', username: 'rendezvous', password: password.result,
  dbSubnetGroupName: subnetGroup.name, vpcSecurityGroupIds: [dbSg.id], publiclyAccessible: false,
  multiAz: config.getBoolean('multiAz') ?? false,
  backupRetentionPeriod: dbBackupRetentionDays, deleteAutomatedBackups: false,
  deletionProtection: true, skipFinalSnapshot: false,
  finalSnapshotIdentifier: `${pulumi.getProject()}-${pulumi.getStack()}-final`,
  autoMinorVersionUpgrade: true, applyImmediately: false,
  enabledCloudwatchLogsExports: ['postgresql'], copyTagsToSnapshot: true, tags,
}, { protect: true });
const credentials = new aws.secretsmanager.Secret('app-secrets', { recoveryWindowInDays: 30, tags }, { protect: true });
const credentialVersion = new aws.secretsmanager.SecretVersion('app-secret-values', {
  secretId: credentials.id,
  secretString: pulumi.all([database.address, password.result, pepper.result]).apply(([host, pass, tokenPepper]) => JSON.stringify({
    DATABASE_URL: `postgresql://rendezvous:${pass}@${host}:5432/rendezvous?sslmode=verify-full&sslrootcert=/app/rds-ca.pem`,
    TOKEN_PEPPER: tokenPepper,
  })),
});

const assumeTask = aws.iam.getPolicyDocumentOutput({ statements: [{
  actions: ['sts:AssumeRole'], principals: [{ type: 'Service', identifiers: ['ecs-tasks.amazonaws.com'] }],
}] }).json;
const executionRole = new aws.iam.Role('execution-role', { assumeRolePolicy: assumeTask, tags });
const executionPolicy = new aws.iam.RolePolicyAttachment('execution-policy', {
  role: executionRole.name, policyArn: 'arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy',
});
const secretPolicy = new aws.iam.RolePolicy('read-app-secrets', {
  role: executionRole.id,
  policy: credentials.arn.apply(arn => JSON.stringify({ Version: '2012-10-17', Statement: [{
    Effect: 'Allow', Action: ['secretsmanager:GetSecretValue'], Resource: arn,
  }] })),
});
const taskRole = new aws.iam.Role('task-role', { assumeRolePolicy: assumeTask, tags });
const logs = new aws.cloudwatch.LogGroup('logs', { retentionInDays: logRetentionDays, tags });
const cluster = new aws.ecs.Cluster('cluster', { tags });

function buildImage(name: string, context: string, args: Record<string, string> = {}) {
  const repo = new aws.ecr.Repository(`${name}-repository`, { imageScanningConfiguration: { scanOnPush: true }, tags });
  const auth = aws.ecr.getAuthorizationTokenOutput({ registryId: repo.registryId });
  return new docker.Image(`${name}-image`, {
    imageName: pulumi.interpolate`${repo.repositoryUrl}:app`,
    build: { context, platform: 'linux/amd64', args },
    registry: { server: repo.repositoryUrl, username: auth.userName, password: auth.password },
  });
}
const backendImage = buildImage('backend', '..');
const frontendImage = buildImage('frontend', '../frontend', { EXPRESS_URL: 'http://127.0.0.1:4372' });

let certificateArn: pulumi.Input<string> = suppliedCertificate!;
let certificateValidation: aws.acm.CertificateValidation | undefined;
if (!suppliedCertificate && zoneId) {
  const certificate = new aws.acm.Certificate('certificate', { domainName: domain, validationMethod: 'DNS', tags });
  const validationRecord = new aws.route53.Record('certificate-validation-record', {
    zoneId,
    name: certificate.domainValidationOptions.apply(o => o[0].resourceRecordName),
    type: certificate.domainValidationOptions.apply(o => o[0].resourceRecordType),
    records: [certificate.domainValidationOptions.apply(o => o[0].resourceRecordValue)], ttl: 300,
  });
  certificateValidation = new aws.acm.CertificateValidation('certificate-validation', {
    certificateArn: certificate.arn, validationRecordFqdns: [validationRecord.fqdn],
  });
  certificateArn = certificateValidation.certificateArn;
}
const balancer = new aws.lb.LoadBalancer('load-balancer', {
  loadBalancerType: 'application', internal: false, securityGroups: [albSg.id],
  subnets: publicSubnets.map(s => s.id), idleTimeout: 120, dropInvalidHeaderFields: true,
  xffHeaderProcessingMode: 'append', tags,
});
const target = new aws.lb.TargetGroup('frontend-target', {
  vpcId: vpc.id, port: 3000, protocol: 'HTTP', targetType: 'ip', deregistrationDelay: 65,
  healthCheck: { path: '/health', matcher: '200', interval: 30, timeout: 5 }, tags,
});
new aws.lb.Listener('http-redirect', {
  loadBalancerArn: balancer.arn, port: 80, protocol: 'HTTP',
  defaultActions: [{ type: 'redirect', redirect: { port: '443', protocol: 'HTTPS', statusCode: 'HTTP_301' } }],
});
const https = new aws.lb.Listener('https', {
  loadBalancerArn: balancer.arn, port: 443, protocol: 'HTTPS', certificateArn,
  sslPolicy: 'ELBSecurityPolicy-TLS13-1-2-2021-06',
  defaultActions: [{ type: 'forward', targetGroupArn: target.arn }],
});
if (zoneId) new aws.route53.Record('site-dns', {
  zoneId, name: domain, type: 'A',
  aliases: [{ name: balancer.dnsName, zoneId: balancer.zoneId, evaluateTargetHealth: true }],
});
const task = new aws.ecs.TaskDefinition('task', {
  family: `${pulumi.getProject()}-${pulumi.getStack()}`,
  requiresCompatibilities: ['FARGATE'], networkMode: 'awsvpc', cpu: '512', memory: '1024',
  executionRoleArn: executionRole.arn, taskRoleArn: taskRole.arn,
  runtimePlatform: { cpuArchitecture: 'X86_64', operatingSystemFamily: 'LINUX' },
  containerDefinitions: pulumi.all([backendImage.repoDigest, frontendImage.repoDigest, credentials.arn, logs.name, region])
    .apply(([backend, frontend, secretArn, logGroup, awsRegion]) => {
      const logConfiguration = (name: string) => ({ logDriver: 'awslogs', options: {
        'awslogs-group': logGroup, 'awslogs-region': awsRegion, 'awslogs-stream-prefix': name,
      } });
      return JSON.stringify([
        { name: 'backend', image: backend, essential: true, stopTimeout: 90,
          environment: Object.entries({ HOST: '127.0.0.1', PORT: '4372',
            PUBLIC_URL: `https://${domain}`, FRONTEND_URL: `https://${domain}`,
            TRUST_PROXY: 'loopback,10.42.0.0/16',
          }).map(([name, value]) => ({ name, value })),
          secrets: ['DATABASE_URL', 'TOKEN_PEPPER'].map(name => ({ name, valueFrom: `${secretArn}:${name}::` })),
          healthCheck: { command: ['CMD-SHELL', "node -e \"fetch('http://127.0.0.1:4372/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""], interval: 10, timeout: 5, retries: 6, startPeriod: 60 },
          logConfiguration: logConfiguration('backend'),
        },
        { name: 'frontend', image: frontend, essential: true, stopTimeout: 90,
          portMappings: [{ containerPort: 3000, protocol: 'tcp' }],
          environment: [{ name: 'EXPRESS_URL', value: 'http://127.0.0.1:4372' }],
          dependsOn: [{ containerName: 'backend', condition: 'HEALTHY' }],
          logConfiguration: logConfiguration('frontend'),
        },
      ]);
    }), tags,
});
const service = new aws.ecs.Service('service', {
  cluster: cluster.arn, taskDefinition: task.arn, desiredCount: 1, launchType: 'FARGATE', platformVersion: '1.4.0',
  // Stop the old relay before starting another: notifications are process-local.
  deploymentMinimumHealthyPercent: 0, deploymentMaximumPercent: 100,
  deploymentCircuitBreaker: { enable: true, rollback: true },
  healthCheckGracePeriodSeconds: 120, waitForSteadyState: true,
  networkConfiguration: { subnets: publicSubnets.map(s => s.id), securityGroups: [taskSg.id], assignPublicIp: true },
  loadBalancers: [{ targetGroupArn: target.arn, containerName: 'frontend', containerPort: 3000 }], tags,
}, { dependsOn: [https, executionPolicy, secretPolicy, credentialVersion] });

export const url = `https://${domain}`;
export const loadBalancerHostname = balancer.dnsName;
export const clusterName = cluster.name;
export const serviceName = service.name;
export const databaseIdentifier = database.identifier;
export const logGroupName = logs.name;

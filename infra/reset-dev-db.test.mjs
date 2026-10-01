import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertDevTarget, assertStopped, resetSqlArgs, resetDev } from './reset-dev-db.mjs';

const outputs = { databaseHost: 'dev.example.us-east-2.rds.amazonaws.com', databaseIdentifier: 'dev-db',
  dbTunnelInstanceId: 'bridge', clusterName: 'cluster', serviceName: 'service' };
const instance = { DBInstanceIdentifier: 'dev-db', Endpoint: { Address: outputs.databaseHost }, Engine: 'postgres' };
const tags = [{ Key: 'Project', Value: 'rendezvous' }, { Key: 'Stack', Value: 'dev' }];

test('requires the exact RDS endpoint and dev project tags', () => {
  assert.doesNotThrow(() => assertDevTarget(outputs, instance, tags));
  assert.throws(() => assertDevTarget(outputs, instance, [{ Key: 'Stack', Value: 'prod' }]), /tags/);
  assert.throws(() => assertDevTarget(outputs, { ...instance, Endpoint: { Address: 'other-host' } }, tags), /does not match/);
  assert.throws(() => assertDevTarget({ ...outputs, databaseHost: "host password=bad" }, instance, tags), /hostname/);
  assert.throws(() => assertDevTarget({ ...outputs, dbTunnelInstanceId: null }, instance, tags), /Missing/);
});

test('requires a positively identified stopped ECS service', () => {
  assert.doesNotThrow(() => assertStopped({ services: [{ desiredCount: 0, runningCount: 0, pendingCount: 0 }] }));
  for (const result of [{}, { services: [] }, { failures: [{}], services: [] },
    ...['desiredCount', 'runningCount', 'pendingCount'].map(key => ({ services: [{ desiredCount: 0, runningCount: 0, pendingCount: 0, [key]: 1 }] }))]) {
    assert.throws(() => assertStopped(result), /zero/);
  }
});

test('database recreation uses separate non-forced statements with a fixed target', () => {
  assert.deepEqual(resetSqlArgs(), ['-c', 'DROP DATABASE IF EXISTS rendezvous;', '-c', 'CREATE DATABASE rendezvous OWNER rendezvous TEMPLATE template0;']);
});

const stages = ['confirm', 'pause', 'verifyStopped', 'recreate', 'resume', 'health'];
test('reset pauses and verifies before dropping, then resumes and checks health', async () => {
  const calls = [];
  await resetDev(Object.fromEntries(stages.map(stage => [stage, async () => { calls.push(stage); }])));
  assert.deepEqual(calls, stages);
});

for (const failedStage of stages) {
  test(`failure at ${failedStage} stops without later actions`, async () => {
    const calls = [];
    await assert.rejects(resetDev(Object.fromEntries(stages.map(stage => [stage, async () => {
      calls.push(stage);
      if (stage === failedStage) throw new Error('simulated failure');
    }]))), /simulated failure/);
    assert.deepEqual(calls, stages.slice(0, stages.indexOf(failedStage) + 1));
  });
}

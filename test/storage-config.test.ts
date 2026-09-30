import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEnv } from 'node:util';
import { readFileSync } from 'node:fs';
import { LOCAL_TOKEN_PEPPER, storageConfig } from '../src/storage-config.js';

test('example env provides matching Docker credentials and requires no DATA_DIR', () => {
  const env = parseEnv(readFileSync('.env.example', 'utf8'));
  const config = storageConfig(env);
  assert.equal(config.embeddedTest, false);
  assert.equal(config.pepper, LOCAL_TOKEN_PEPPER);
  assert.equal(env.DATA_DIR, undefined);
  assert.equal(new URL(config.databaseUrl!).password, env.POSTGRES_PASSWORD);
});

test('application startup requires database and pepper instead of a disk fallback', () => {
  assert.throws(() => storageConfig({ DATA_DIR: '/unused' }), /DATABASE_URL is required/);
  assert.throws(() => storageConfig({ DATABASE_URL: 'postgresql://localhost/db' }), /TOKEN_PEPPER/);
  assert.throws(() => storageConfig({ DATABASE_URL: 'postgresql://localhost/db', TOKEN_PEPPER: 'short' }), /TOKEN_PEPPER/);
  assert.equal(storageConfig({ DATABASE_URL: 'postgresql://localhost/db', TOKEN_PEPPER: LOCAL_TOKEN_PEPPER, DATA_DIR: '/unused' }).embeddedTest, false);
});

test('production refuses the public starter pepper but accepts private configuration', () => {
  const env = { NODE_ENV: 'production', DATABASE_URL: 'postgresql://localhost/db', TOKEN_PEPPER: LOCAL_TOKEN_PEPPER };
  assert.throws(() => storageConfig(env), /local-only TOKEN_PEPPER/);
  assert.equal(storageConfig({ ...env, TOKEN_PEPPER: 'private-test-value'.repeat(4) }).embeddedTest, false);
});

test('embedded storage requires explicit isolated-test configuration', () => {
  assert.throws(() => storageConfig({ NODE_ENV: 'test' }), /DATABASE_URL/);
  assert.equal(storageConfig({ NODE_ENV: 'test', DATA_DIR: '/test-fixture' }).embeddedTest, true);
});

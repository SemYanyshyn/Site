import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import type { Pool } from 'pg';
import { changeUserRole, parseAdminRoleArguments } from '../src/server/admin-role.js';
import { readExecutorPodMetadata } from '../src/server/jobs/executor-config.js';
import { ExecutorRegistry } from '../src/server/jobs/executor-registry.js';

test('Downward API identity is complete, validated and optional for host processes', () => {
  assert.deepEqual(readExecutorPodMetadata({}), { podUid: null, podName: null, podNamespace: null });
  const valid = { POD_UID: randomUUID(), POD_NAME: 'app-655bddc79f-a12bc', POD_NAMESPACE: 'courier-route-test-metadata' };
  assert.deepEqual(readExecutorPodMetadata(valid), { podUid: valid.POD_UID, podName: valid.POD_NAME, podNamespace: valid.POD_NAMESPACE });
  for (const invalid of [{ POD_UID: valid.POD_UID }, { ...valid, POD_UID: 'not-a-uuid' }, { ...valid, POD_NAME: 'wrong/name' },
    { ...valid, POD_NAMESPACE: '../other' }, { ...valid, POD_NAME: 'a..b' }, { ...valid, POD_NAMESPACE: 'a'.repeat(64) },
    { ...valid, POD_NAME: 'a'.repeat(64) }, { ...valid, POD_UID: '' }]) assert.throws(() => readExecutorPodMetadata(invalid));
});

test('heartbeat metadata uses the same bounded single-flight SQL during a busy transition', async () => {
  const issued: { text: string; values: unknown[] }[] = [];
  let complete: (() => void) | undefined;
  let inFlight = 0; let maximum = 0;
  const fakePool = { query: async (text: string, values: unknown[]) => {
    issued.push({ text, values }); maximum = Math.max(maximum, ++inFlight);
    await new Promise<void>((resolve) => { complete = resolve; }); inFlight--;
    return { rows: [], rowCount: 1 };
  } } as unknown as Pool;
  const metadata = { podUid: randomUUID(), podName: 'app-pod', podNamespace: 'courier-route-test-metadata' };
  const registry = new ExecutorRegistry(fakePool, randomUUID(), { heartbeatIntervalMs: 1000, leaseTtlMs: 15000 }, metadata);
  let state = { acceptingClaims: true, busy: false, currentJobId: null as string | null };
  registry.start(() => state, async () => {});
  const first = registry.refresh();
  assert.equal(registry.refresh(), first);
  state = { acceptingClaims: true, busy: true, currentJobId: randomUUID() };
  complete?.();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(issued.length, 2);
  complete?.();
  assert.equal(await first, true);
  assert.equal(maximum, 1);
  assert.deepEqual(issued.map((call) => call.values.slice(5)), [Object.values(metadata), Object.values(metadata)]);
  assert.equal(issued[1]?.values[4], state.currentJobId);
  assert.ok(issued.every((call) => call.text.includes('clock_timestamp()') && call.text.includes('pod_uid = EXCLUDED.pod_uid')));
  await registry.shutdown(performance.now());
});

test('operator role CLI rejects unknown, duplicate and injected options before acquiring SQL', async () => {
  assert.deepEqual(parseAdminRoleArguments(['--role', 'admin', '--username', 'My_Login']), { username: 'My_Login', role: 'admin' });
  for (const args of [[], ['--username', 'user', '--role', 'root'], ['--username', "u';DROP", '--role', 'admin'],
    ['--username', 'user', '--role', 'admin', '--role', 'user'], ['--username', 'user', '--role', 'admin', '--database-url', 'hidden'],
    ['--username', 'user'], ['--username=user', '--role', 'admin']]) assert.throws(() => parseAdminRoleArguments(args));
  let acquired = false;
  const fake = { connect: async () => { acquired = true; throw new Error('unexpected'); } } as unknown as Pool;
  await assert.rejects(changeUserRole(fake, { username: 'valid', role: 'root' as 'admin' }));
  assert.equal(acquired, false);
});

test('monitor RBAC cannot mutate, read secrets/logs, list deployments or target a foreign namespace', async () => {
  const rbac = JSON.parse(await readFile(new URL('../deploy/k8s/monitor-rbac.json', import.meta.url), 'utf8'));
  const role = rbac.items.find((item: { kind: string }) => item.kind === 'Role');
  const binding = rbac.items.find((item: { kind: string }) => item.kind === 'RoleBinding');
  type Rule = { apiGroups: string[]; resources: string[]; verbs: string[]; resourceNames?: string[] };
  const allowed = (group: string, resource: string, verb: string, name: string, namespace = '__NAMESPACE__') => namespace === role.metadata.namespace
    && role.rules.some((rule: Rule) => rule.apiGroups.includes(group) && rule.resources.includes(resource) && rule.verbs.includes(verb)
      && (!rule.resourceNames || rule.resourceNames.includes(name)));
  assert.ok(allowed('', 'pods', 'list', ''));
  assert.ok(allowed('metrics.k8s.io', 'pods', 'get', 'app-pod'));
  assert.ok(allowed('apps', 'deployments', 'get', 'app'));
  assert.ok(allowed('autoscaling', 'horizontalpodautoscalers', 'get', 'app'));
  for (const [group, resource, verb, name, namespace] of [['', 'secrets', 'get', 'database'], ['', 'pods/log', 'get', 'app-pod'],
    ['', 'pods/exec', 'create', 'app-pod'], ['', 'pods', 'delete', 'app-pod'], ['apps', 'deployments/scale', 'update', 'app'],
    ['apps', 'deployments', 'list', ''], ['apps', 'deployments', 'get', 'traefik'], ['', 'pods', 'get', 'app-pod', 'foreign']]) {
    assert.equal(allowed(group!, resource!, verb!, name!, namespace), false);
  }
  assert.equal(binding.roleRef.name, role.metadata.name);
  assert.equal(binding.subjects[0].namespace, '__NAMESPACE__');
  const app = JSON.parse(await readFile(new URL('../deploy/k8s/app.json', import.meta.url), 'utf8')).items.find((item: { kind: string }) => item.kind === 'Deployment');
  const spec = app.spec.template.spec;
  assert.equal(spec.automountServiceAccountToken, false);
  assert.equal(spec.serviceAccountName, binding.subjects[0].name);
  assert.equal(spec.securityContext.fsGroup, 1000);
  const volume = spec.volumes.find((value: { name: string }) => value.name === 'monitor-api');
  assert.ok(volume.projected.sources.some((value: { serviceAccountToken?: { expirationSeconds: number } }) => value.serviceAccountToken?.expirationSeconds === 3600));
  const migration = JSON.parse(await readFile(new URL('../deploy/k8s/migrate.json', import.meta.url), 'utf8')).spec.template.spec;
  assert.equal(migration.automountServiceAccountToken, false);
  assert.equal(migration.volumes.some((value: { projected?: unknown }) => value.projected), false);
  assert.equal(migration.containers[0].env.some((value: { name: string }) => /TOKEN|POD_|ADMIN_/.test(value.name)), false);
});

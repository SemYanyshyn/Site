import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { appApplyPlan, assertObjectOwner, replicaHandoffPatch } from './deployment-autoscale.mjs';
import { assertDeploymentDeadline, runDeploymentCommand, withoutDeploymentDeadline } from './deployment-command.mjs';
export { withDeploymentDeadline, withoutDeploymentDeadline } from './deployment-command.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const local = join(root, '.local/deploy');
const versions = JSON.parse(await readFile(join(root, 'deploy/versions.json'), 'utf8'));
const statePath = join(local, 'cluster.json');
const kubeconfig = join(local, 'kubeconfig');
const context = 'kind-courier-route';
const cluster = 'courier-route';
const dockerEnvironment = { ...process.env,
  DOCKER_HOST: process.env.COURIER_DOCKER_HOST ?? `unix://${homedir()}/.colima/courier-route/docker.sock` };
const managedLabel = 'courier-route-local';
const hidden = new Set();
const forwardings = new Map();

function safe(message) {
  let value = String(message).replace(/postgres(?:ql)?:\/\/\S+/giu, '[database address]');
  for (const secret of hidden) value = value.replaceAll(secret, '[redacted]');
  return value.slice(-1600);
}

/** Input can contain credentials; it is never included in an error or command line. */
function run(command, args, { input, timeoutMs = 120_000, env = process.env, inherit = false } = {}) {
  return runDeploymentCommand(command, args, { cwd: root, input, timeoutMs, env, inherit, redact: safe });
}

async function privateFile(path, value) {
  await mkdir(resolve(path, '..'), { recursive: true, mode: 0o700 });
  await writeFile(path, value, { mode: 0o600 });
  await chmod(path, 0o600);
}

async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error instanceof SyntaxError) throw new Error('A project JSON file is malformed; no file contents were logged.');
    throw error;
  }
}

function port(value, fallback) {
  const number = Number(value ?? fallback);
  assert.ok(Number.isInteger(number) && number >= 1024 && number <= 65535, 'Use an unprivileged port (1024–65535).');
  return number;
}

async function availablePort(value = 0) {
  const server = createServer();
  await new Promise((accept, reject) => { server.once('error', reject); server.listen(value, '127.0.0.1', accept); });
  const result = server.address().port;
  await new Promise((accept) => server.close(accept));
  return result;
}

export async function preflight() {
  assert.equal(Number(process.versions.node.split('.')[0]), 24, 'Node.js 24.x is required.');
  const commands = await Promise.all([
    run('docker', ['version', '--format', '{{.Server.Version}}'], { env: dockerEnvironment }),
    run('kind', ['version']), run('kubectl', ['version', '--client', '-o', 'json']), run('openssl', ['version']), run('npm', ['--version']),
  ]);
  assert.match(commands[1], new RegExp(`v${versions.kind.version.replaceAll('.', '\\.')}`), 'Use the pinned kind release.');
  assert.equal(JSON.parse(commands[2]).clientVersion.minor.replace(/\D/gu, ''), '36', 'kubectl must match Kubernetes minor 36.');
  assert.match(commands[3], /^OpenSSL 3\./u, 'OpenSSL 3 is required for local certificate provisioning.');
  assert.match(commands[4], /^11\./u, 'npm 11.x is required.');
  return { node: process.version, npm: commands[4].trim(), architecture: process.arch, dockerServer: commands[0].trim(), kind: versions.kind.version,
    kubectl: JSON.parse(commands[2]).clientVersion.gitVersion, openssl: commands[3].trim(), runtime: dockerEnvironment.DOCKER_HOST };
}

export async function imageName() {
  const hash = createHash('sha256');
  async function add(path) {
    const full = join(root, path);
    if ((await stat(full)).isDirectory()) {
      for (const child of (await readdir(full)).sort()) await add(`${path}/${child}`);
    } else { hash.update(path); hash.update(await readFile(full)); }
  }
  for (const path of ['Dockerfile', '.dockerignore', 'package.json', 'package-lock.json', 'src', 'migrations', 'examples',
    'tsconfig.json', 'tsconfig.server.json', 'tsconfig.client.json', 'tsconfig.tools.json', 'tsconfig.tests.json', 'vite.config.ts',
    'scripts/clean.mjs', 'scripts/copy-migrations.mjs', 'scripts/copy-route-examples.mjs']) await add(path);
  return `courier-route:block07-${hash.digest('hex').slice(0, 16)}`;
}

export async function buildImage() {
  await preflight();
  const image = await imageName();
  const fingerprintLabel = 'courier-route.source-fingerprint';
  const inspect = async () => JSON.parse(await run('docker', ['image', 'inspect', image], { env: dockerEnvironment }))[0];
  const matches = (value) => value?.Config?.Labels?.[fingerprintLabel] === image
    && value.Config.User === 'node' && value.Config.Env?.includes(`NODE_VERSION=${versions.node.version}`);
  let existing;
  try { existing = await inspect(); } catch { /* A missing local source tag must be built. */ }
  // A source tag denotes one local artifact, not a request to rebuild layers
  // with new timestamps. All actual Docker build inputs feed imageName().
  if (!matches(existing)) {
    await run('docker', ['build', '--tag', image, '--label', `${fingerprintLabel}=${image}`, '.'],
      { env: dockerEnvironment, timeoutMs: 900_000, inherit: true });
    assert.ok(matches(await inspect()), 'The built image must match its source fingerprint, nonroot user and pinned Node runtime.');
  }
  return image;
}

function replace(value, tokens) {
  if (typeof value === 'string') {
    if (Object.hasOwn(tokens, value)) return tokens[value];
    return value.replace(/__[A-Z_]+__/gu, (key) => {
      assert.ok(Object.hasOwn(tokens, key), `Unknown manifest token ${key}`);
      return String(tokens[key]);
    });
  }
  if (Array.isArray(value)) return value.map((item) => replace(item, tokens));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replace(item, tokens)]));
  return value;
}

async function clusterState({ create = false } = {}) {
  await preflight();
  await mkdir(local, { recursive: true, mode: 0o700 });
  let state = await readJson(statePath);
  const clusters = (await run('kind', ['get', 'clusters'], { env: dockerEnvironment })).trim().split('\n');
  if (clusters.includes(cluster)) {
    assert.ok(state?.ownerId && state.cluster === cluster && state.context === context, 'Existing cluster has no project ownership record; refusing to adopt it.');
    const inspect = JSON.parse(await run('docker', ['inspect', `${cluster}-control-plane`], { env: dockerEnvironment }))[0];
    assert.equal(inspect.Config.Labels['io.x-k8s.kind.cluster'], cluster);
    assert.equal(inspect.Config.Image, versions.kind.nodeImage, 'The existing cluster must use the pinned kind node image.');
    for (const [containerPort, hostPort] of [['30080/tcp', state.httpPort], ['30443/tcp', state.httpsPort]]) {
      const mapping = inspect.HostConfig.PortBindings[containerPort]?.[0];
      assert.equal(mapping?.HostIp, '127.0.0.1');
      assert.equal(mapping?.HostPort, String(hostPort));
    }
  } else {
    assert.ok(create, 'Project cluster is not running. Use npm run deploy:local.');
    const httpPort = port(process.env.COURIER_HTTP_PORT, state?.httpPort ?? 8080);
    const httpsPort = port(process.env.COURIER_HTTPS_PORT, state?.httpsPort ?? 8443);
    assert.notEqual(httpPort, httpsPort);
    await availablePort(httpPort); await availablePort(httpsPort);
    state ??= { cluster, context, ownerId: randomUUID(), httpPort, httpsPort };
    assert.equal(state.httpPort, httpPort); assert.equal(state.httpsPort, httpsPort);
    await privateFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
    const config = replace(await readJson(join(root, 'deploy/kind-config.json')), {
      __HTTP_PORT__: httpPort, __HTTPS_PORT__: httpsPort, __KIND_NODE_IMAGE__: versions.kind.nodeImage,
    });
    const configPath = join(local, 'kind-config.json');
    await privateFile(configPath, JSON.stringify(config));
    await run('kind', ['create', 'cluster', '--name', cluster, '--config', configPath,
      '--kubeconfig', kubeconfig, '--wait', '180s'], { env: dockerEnvironment, timeoutMs: 900_000, inherit: true });
  }
  await privateFile(kubeconfig, await run('kind', ['get', 'kubeconfig', '--name', cluster], { env: dockerEnvironment }));
  return state;
}

function kubectlFor(namespace) {
  assert.ok(namespace === 'kube-system' || /^courier-route(?:-metrics|-test-[a-z0-9-]+)?$/u.test(namespace));
  return async (args, { input, timeoutMs = 120_000, json = false } = {}) => {
    const result = await run('kubectl', ['--kubeconfig', kubeconfig, '--context', context, '--namespace', namespace,
      '--request-timeout=30s', ...args], { input, timeoutMs });
    return json ? JSON.parse(result) : result;
  };
}

async function assertClusterOwnership(state) {
  assert.equal(state?.cluster, cluster);
  assert.equal(state?.context, context);
  assert.match(state?.ownerId, /^[0-9a-f-]{36}$/u);
  const node = JSON.parse(await run('docker', ['inspect', `${cluster}-control-plane`], { env: dockerEnvironment }))[0];
  assert.equal(node.Config.Labels['io.x-k8s.kind.cluster'], cluster);
  assert.equal(node.Config.Image, versions.kind.nodeImage);
  const nodes = await kubectlFor('courier-route-metrics')(['get', 'nodes', '-o', 'json'], { json: true });
  assert.equal(nodes.items.length, 1, 'This local add-on requires the exact owned single-node kind cluster.');
  assert.equal(nodes.items[0].metadata.name, `${cluster}-control-plane`);
  assert.equal(nodes.items[0].status.nodeInfo.kubeletVersion, `v${versions.kind.kubernetesVersion}`);
}

async function loadOwnedImage(state, image) {
  // Docker's local image store and kind's containerd store are independent.
  // Fail before creating a namespace if the exact built artifact is absent,
  // then load it through only this project's already verified runtime.
  await assertClusterOwnership(state);
  const metadata = JSON.parse(await run('docker', ['image', 'inspect', image], { env: dockerEnvironment }))[0];
  assert.equal(metadata?.Config?.Labels?.['courier-route.source-fingerprint'], image,
    'Build the exact current source image with npm run image:build before deployment checks.');
  assert.equal(metadata.Config.User, 'node');
  assert.ok(metadata.Config.Env?.includes(`NODE_VERSION=${versions.node.version}`));
  await run('kind', ['load', 'docker-image', image, '--name', cluster],
    { env: dockerEnvironment, timeoutMs: 180_000, inherit: true });
}

/** Shared cluster add-on: check EVERY target before changing ANY target.
 * Disposable namespace cleanup never removes this installation. Foreign
 * add-ons are deliberately rejected rather than silently adopted/overwritten. */
async function ensureMetricsServer(state) {
  await assertClusterOwnership(state);
  const namespace = versions.metricsServer.namespace;
  assert.equal(namespace, 'courier-route-metrics');
  const manifest = replace(await readJson(join(root, 'deploy/k8s/metrics-server.json')), {
    __CLUSTER_OWNER_ID__: state.ownerId, __METRICS_SERVER_IMAGE__: versions.metricsServer.image,
  });
  const resources = {
    Namespace: 'namespaces', ServiceAccount: 'serviceaccounts', Service: 'services', Deployment: 'deployments.apps',
    ClusterRole: 'clusterroles.rbac.authorization.k8s.io', ClusterRoleBinding: 'clusterrolebindings.rbac.authorization.k8s.io',
    RoleBinding: 'rolebindings.rbac.authorization.k8s.io', APIService: 'apiservices.apiregistration.k8s.io',
  };
  assert.equal(manifest.kind, 'List');
  for (const object of manifest.items) {
    assert.ok(Object.hasOwn(resources, object.kind), 'Unexpected cluster add-on resource.');
    const objectNamespace = object.metadata.namespace;
    assert.ok(objectNamespace === undefined || objectNamespace === namespace
      || (object.kind === 'RoleBinding' && objectNamespace === 'kube-system'));
    if (object.kind === 'Namespace') assert.equal(object.metadata.name, namespace);
    assertObjectOwner(object, { namespace: objectNamespace, ownerId: state.ownerId, kind: object.kind, name: object.metadata.name });
    const prior = await kubectlFor(objectNamespace ?? namespace)([
      'get', resources[object.kind], object.metadata.name, '--ignore-not-found', '-o', 'json',
    ]);
    if (prior.trim()) assertObjectOwner(JSON.parse(prior), {
      namespace: objectNamespace, ownerId: state.ownerId, kind: object.kind, name: object.metadata.name,
    });
  }
  const kubectl = kubectlFor(namespace);
  // kubectl's explicit namespace must match each namespaced object; the
  // kube-system auth-reader binding cannot share the add-on namespace flag.
  for (const object of manifest.items) await kubectlFor(object.metadata.namespace ?? namespace)(
    ['apply', '-f', '-'], { input: JSON.stringify(object) });
  await kubectl(['rollout', 'status', 'deployment/metrics-server', '--timeout=180s'], { timeoutMs: 190_000 });
  await kubectl(['wait', '--for=condition=Available', 'apiservice/v1beta1.metrics.k8s.io', '--timeout=90s'], { timeoutMs: 100_000 });
  const deadline = Date.now() + 90_000;
  while (true) {
    try {
      const metrics = await kubectl(['get', '--raw', '/apis/metrics.k8s.io/v1beta1/nodes'], { json: true });
      assert.ok(metrics.items.some((item) => item.metadata.name === `${cluster}-control-plane`
        && typeof item.timestamp === 'string' && typeof item.window === 'string' && item.usage?.cpu && item.usage?.memory));
      return;
    } catch (error) {
      if (error?.code === 'DEPLOYMENT_DEADLINE') throw error;
      assertDeploymentDeadline();
      assert.ok(Date.now() < deadline, 'Metrics API has no usable owned-node CPU/RAM samples before its deadline.');
      await delay(1000);
    }
  }
}

async function certificates() {
  const directory = join(local, 'tls');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const caPath = join(directory, 'ca.crt');
  const caKey = join(directory, 'ca.key');
  const cert = join(directory, 'localhost.crt');
  const key = join(directory, 'localhost.key');
  if (!await stat(caPath).catch(() => null)) {
    assert.equal(await stat(caKey).catch(() => null), null, 'Existing CA key without certificate needs manual recovery.');
    await run('openssl', ['req', '-x509', '-newkey', 'rsa:3072', '-noenc', '-sha256', '-days', '365',
      '-subj', '/CN=Courier Route local project CA', '-addext', 'basicConstraints=critical,CA:TRUE,pathlen:0',
      '-addext', 'keyUsage=critical,keyCertSign,cRLSign', '-keyout', caKey, '-out', caPath]);
  }
  await run('openssl', ['x509', '-in', caPath, '-checkend', '86400', '-noout']);
  let valid = false;
  try {
    await run('openssl', ['verify', '-CAfile', caPath, '-verify_hostname', 'localhost', cert]);
    await run('openssl', ['x509', '-in', cert, '-checkend', '86400', '-noout']);
    valid = true;
  } catch { /* A short-lived leaf can be renewed under the same project CA. */ }
  if (!valid) {
    const csr = join(directory, 'localhost.csr');
    const extensions = join(directory, 'localhost.ext');
    await privateFile(extensions, 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n');
    await run('openssl', ['req', '-new', '-newkey', 'rsa:2048', '-noenc', '-subj', '/CN=localhost', '-keyout', key, '-out', csr]);
    await run('openssl', ['x509', '-req', '-in', csr, '-CA', caPath, '-CAkey', caKey, '-set_serial', `0x${randomBytes(16).toString('hex')}`,
      '-days', '30', '-sha256', '-extfile', extensions, '-out', cert]);
    await rm(csr); await rm(extensions);
  }
  for (const path of [caPath, caKey, cert, key]) await chmod(path, 0o600);
  await run('openssl', ['verify', '-CAfile', caPath, '-verify_hostname', 'localhost', cert]);
  assert.equal((await run('openssl', ['x509', '-in', cert, '-pubkey', '-noout'])).trim(),
    (await run('openssl', ['pkey', '-in', key, '-pubout'])).trim(), 'TLS key must match certificate.');
  return { caPath, cert: await readFile(cert, 'utf8'), key: await readFile(key, 'utf8') };
}

async function closeForwarding(namespace) {
  const child = forwardings.get(namespace);
  forwardings.delete(namespace);
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise((resolve) => child.once('close', resolve));
  child.kill('SIGTERM');
  if (!await Promise.race([closed.then(() => true), delay(3000, false, { ref: false })])) {
    child.kill('SIGKILL');
    await closed;
  }
}

async function waitForPublicHttps(origin, caPath) {
  const deadline = Date.now() + 15_000;
  // The helper command inherits the absolute acceptance deadline and is
  // actually killed/reaped on timeout. This is a safe GET with normal TLS;
  // TCP listening alone does not prove Traefik has learned the new endpoints.
  const source = `import https from 'node:https';import{readFile}from'node:fs/promises';
    let input='';for await(const chunk of process.stdin)input+=chunk;const{origin,caPath}=JSON.parse(input);
    const ca=await readFile(caPath);const ready=await new Promise(resolve=>{
      const request=https.get(new URL('/api/health',origin),{ca,family:4,agent:false},response=>{
        const id=response.headers['x-instance-id'];const ok=response.statusCode===200&&typeof id==='string'
          &&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
        response.once('error',()=>resolve(false));response.once('end',()=>resolve(ok));response.resume();
      });request.once('error',()=>resolve(false));
    });if(!ready)process.exitCode=1;`;
  while (Date.now() < deadline) {
    assertDeploymentDeadline();
    try {
      await run(process.execPath, ['--input-type=module', '-e', source], {
        input: JSON.stringify({ origin, caPath }), timeoutMs: Math.min(3000, Math.max(1, deadline - Date.now())),
      });
      return;
    } catch (error) {
      if (error?.code === 'DEPLOYMENT_DEADLINE') throw error;
      assertDeploymentDeadline();
      await delay(200);
    }
  }
  throw new Error('The owned public HTTPS route did not reach a real app process before its readiness deadline.');
}

async function stopNamespace(kubectl, namespace, ownerId) {
  const objects = [
    ['namespace', namespace, 'Namespace', undefined],
    ['deployment', 'app', 'Deployment', namespace],
    ['deployment', 'traefik', 'Deployment', namespace],
    ['statefulset', 'postgres', 'StatefulSet', namespace],
  ];
  for (const [resource, name, kind, objectNamespace] of objects) {
    const object = await kubectl(['get', resource, name, '-o', 'json'], { json: true });
    assertObjectOwner(object, { namespace: objectNamespace, ownerId, kind, name });
  }
  const hpa = await kubectl(['get', 'hpa', 'app', '--ignore-not-found', '-o', 'json']);
  if (hpa.trim()) {
    assertObjectOwner(JSON.parse(hpa), { namespace, ownerId, kind: 'HorizontalPodAutoscaler', name: 'app' });
    await kubectl(['delete', 'hpa', 'app', '--wait=true', '--timeout=30s'], { timeoutMs: 40_000 });
  }
  // A service port-forward pins one actual Traefik pod. It may keep its local
  // socket open after that pod disappears, until the next HTTPS request fails.
  // Explicit stop must reap it before start can create a fresh fixed-port one.
  await closeForwarding(namespace);
  // Delete only the namespace's owned HPA BEFORE scale-to-zero. Leave the
  // shared Metrics Server and every other namespace's autoscaler untouched.
  await kubectl(['scale', 'deployment/app', 'deployment/traefik', '--replicas=0']);
  await kubectl(['wait', '--for=delete', 'pod', '-l', 'app.kubernetes.io/component in (app,ingress)', '--timeout=60s'], { timeoutMs: 70_000 });
  await kubectl(['scale', 'statefulset/postgres', '--replicas=0']);
  await kubectl(['wait', '--for=delete', 'pod', '-l', 'app.kubernetes.io/component=database', '--timeout=60s'], { timeoutMs: 70_000 });
}

async function provision({ state, namespace, ownerId, httpPort, httpsPort, image, testing = false, autoscaling = !testing }) {
  assert.equal(typeof autoscaling, 'boolean');
  if (autoscaling) await ensureMetricsServer(state);
  const kubectl = kubectlFor(namespace);
  const publicOrigin = `https://localhost:${httpsPort}`;
  const migrationName = `migrate-${image.split('-').at(-1)}`;
  const tokens = { __NAMESPACE__: namespace, __OWNER_ID__: ownerId, __PUBLIC_ORIGIN__: publicOrigin,
    __HTTP_PORT__: httpPort, __HTTPS_PORT__: httpsPort, __APP_IMAGE__: image,
    __POSTGRES_IMAGE__: versions.postgres.image, __TRAEFIK_IMAGE__: versions.traefik.image, __MIGRATION_JOB__: migrationName };
  const configData = replace((await readJson(join(root, 'deploy/k8s/config.json'))).data, tokens);
  if (testing && !autoscaling) configData.JOBS_MAX_OUTSTANDING = '4';
  const configChecksum = createHash('sha256').update(JSON.stringify(configData)).digest('hex');
  const labels = { 'app.kubernetes.io/part-of': 'courier-route', 'app.kubernetes.io/managed-by': managedLabel,
    'courier-route.local/owner-id': ownerId };
  async function assertOwned() {
    const value = await kubectl(['get', 'namespace', namespace, '-o', 'json'], { json: true });
    assert.equal(value.metadata.name, namespace);
    assert.equal(value.metadata.labels['app.kubernetes.io/managed-by'], managedLabel);
    assert.equal(value.metadata.labels['courier-route.local/owner-id'], ownerId);
  }
  const existing = await kubectl(['get', 'namespace', namespace, '--ignore-not-found', '-o', 'json']);
  if (existing.trim()) await assertOwned();
  async function apply(value) { await kubectl(['apply', '-f', '-'], { input: JSON.stringify(value) }); }
  async function handoff(live) {
    const patch = replicaHandoffPatch(live);
    if (patch) await kubectl(['patch', 'deployment', 'app', '--type=json', '-p', JSON.stringify(patch)]);
  }
  async function applyApplication() {
    await assertOwned();
    const prior = await kubectl(['get', 'hpa', 'app', '--ignore-not-found', '-o', 'json']);
    if (prior.trim()) assertObjectOwner(JSON.parse(prior), { namespace, ownerId, kind: 'HorizontalPodAutoscaler', name: 'app' });
    if (!autoscaling) assert.ok(!prior.trim(), 'The static deployment regression must not have an HPA.');
    const encoded = await kubectl(['get', 'deployment', 'app', '--ignore-not-found', '-o', 'json']);
    const live = encoded.trim() ? JSON.parse(encoded) : null;
    const plan = appApplyPlan(await manifest('app'), live, { autoscaling, namespace, ownerId });
    if (plan.handoffPatch) await kubectl(['patch', 'deployment', 'app', '--type=json', '-p', JSON.stringify(plan.handoffPatch)]);
    await apply(plan.manifest);
    // Bootstrap explicitly writes 2 once, then releases annotation ownership
    // before HPA creation. Repeats omit replicas without writing current scale.
    if (autoscaling && plan.bootstrap) await handoff(await kubectl(['get', 'deployment', 'app', '-o', 'json'], { json: true }));
    if (autoscaling) await apply(await manifest('hpa'));
  }
  async function manifest(name) {
    const value = replace(await readJson(join(root, `deploy/k8s/${name}.json`)), tokens);
    if (name === 'config') value.data = configData;
    if (name === 'app') {
      const deployment = value.items.find((item) => item.kind === 'Deployment');
      deployment.spec.template.metadata.annotations = { 'courier-route.local/config-checksum': configChecksum };
    }
    if (testing && name === 'traefik') {
      const service = value.items.find((item) => item.kind === 'Service');
      service.spec.type = 'ClusterIP';
      for (const entry of service.spec.ports) delete entry.nodePort;
    }
    return value;
  }
  await apply(await manifest('namespace'));
  const monitorRbac = await manifest('monitor-rbac');
  // Preflight every existing target before changing any of these rights. A
  // namespace label alone does not prove ownership of a pre-existing Role.
  for (const object of monitorRbac.items) {
    const prior = await kubectl(['get', object.kind, object.metadata.name, '--ignore-not-found', '-o', 'json']);
    if (prior.trim()) assertObjectOwner(JSON.parse(prior), { namespace, ownerId, kind: object.kind, name: object.metadata.name });
  }
  await apply(monitorRbac);
  const directory = join(local, namespace);
  const credentialsPath = join(directory, 'credentials.json');
  let credentials = await readJson(credentialsPath);
  if (!credentials) {
    const claims = await kubectl(['get', 'pvc', '-o', 'json'], { json: true });
    assert.equal(claims.items.length, 0, 'PVC exists without local credentials. Refusing to reset its passwords.');
    credentials = { ownerId, admin: randomBytes(32).toString('base64url'), app: randomBytes(32).toString('base64url') };
    await privateFile(credentialsPath, `${JSON.stringify(credentials)}\n`);
  }
  assert.equal(credentials.ownerId, ownerId);
  hidden.add(credentials.admin); hidden.add(credentials.app);
  async function secret(name, stringData, type = 'Opaque') {
    // Server-side apply avoids a second plaintext copy in the client-side
    // last-applied annotation. Secret values still travel only via stdin.
    const data = Object.fromEntries(Object.entries(stringData).map(([key, value]) => [key, Buffer.from(value).toString('base64')]));
    for (const value of Object.values(stringData)) {
      hidden.add(value); hidden.add(JSON.stringify(value).slice(1, -1)); hidden.add(Buffer.from(value).toString('base64'));
    }
    await kubectl(['apply', '--server-side', '--field-manager=courier-route-local', '-f', '-'],
      { input: JSON.stringify({ apiVersion: 'v1', kind: 'Secret', metadata: { name, namespace, labels }, type, data }) });
    await kubectl(['patch', 'secret', name, '--type=merge', '-p',
      '{"metadata":{"annotations":{"kubectl.kubernetes.io/last-applied-configuration":null}}}']);
  }
  const database = testing ? 'courier_route_test' : 'courier_route';
  const secondDatabase = testing ? 'courier_route_test_aux' : 'courier_route_test';
  const databaseUrl = (name) => `postgresql://courier_route:${encodeURIComponent(credentials.app)}@postgres:5432/${name}`;
  await secret('courier-route-postgres', { POSTGRES_PASSWORD: credentials.admin });
  await secret('courier-route-database', { DATABASE_URL: databaseUrl(database),
    TEST_DATABASE_URL: databaseUrl(secondDatabase), APP_DB_PASSWORD: credentials.app });
  const tls = await certificates();
  hidden.add(tls.key);
  await secret('courier-route-tls', { 'tls.crt': tls.cert, 'tls.key': tls.key }, 'kubernetes.io/tls');
  await apply(await manifest('config'));
  await apply(await manifest('postgres'));
  await kubectl(['rollout', 'status', 'statefulset/postgres', '--timeout=180s'], { timeoutMs: 190_000 });
  // pg_isready can see the image's temporary init server. Bootstrap only after
  // the entrypoint has exec'd the final PostgreSQL PID 1.
  const postgresDeadline = Date.now() + 30_000;
  while (true) {
    try {
      await kubectl(['exec', 'postgres-0', '-c', 'postgres', '--', 'sh', '-c',
        'test "$(cat /proc/1/comm)" = postgres && psql -U postgres -d postgres -Atqc "SELECT 1"'], { timeoutMs: 10_000 });
      break;
    } catch (error) {
      if (error?.code === 'DEPLOYMENT_DEADLINE') throw error;
      assertDeploymentDeadline();
      assert.ok(Date.now() < postgresDeadline, 'Final PostgreSQL startup deadline.');
      await delay(200);
    }
  }
  // Administrative bootstrap stays inside this namespace's PostgreSQL pod. The
  // password travels only through stdin and is never given to the HTTP process.
  const quote = (value) => `'${value.replaceAll("'", "''")}'`;
  const bootstrap = `SET log_statement='none'; SET log_min_error_statement='panic';\nSELECT format('CREATE ROLE courier_route LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD %L', ${quote(credentials.app)}) WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname='courier_route')\\gexec\n`
    + [database, secondDatabase].map((name) => `SELECT format('CREATE DATABASE %I OWNER courier_route', ${quote(name)}) WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname=${quote(name)})\\gexec\n`).join('')
    + "DO $$ BEGIN IF EXISTS (SELECT FROM pg_roles WHERE rolname='courier_route' AND (rolsuper OR rolcreatedb OR rolcreaterole)) THEN RAISE EXCEPTION 'Unsafe application role'; END IF; END $$;\n";
  await kubectl(['exec', '-i', 'postgres-0', '-c', 'postgres', '--', 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'], { input: bootstrap });
  const prior = await kubectl(['get', 'job', migrationName, '--ignore-not-found', '-o', 'json']);
  if (prior.trim()) {
    const job = JSON.parse(prior);
    assert.equal(job.metadata.labels['courier-route.local/owner-id'], ownerId);
    assert.equal(job.spec.template.spec.containers[0].image, image);
    assert.ok(!job.status.failed, 'Previous migration failed; inspect it before a new explicit attempt.');
  } else await apply(await manifest('migrate'));
  await kubectl(['wait', '--for=condition=complete', `job/${migrationName}`, '--timeout=130s'], { timeoutMs: 140_000 });
  await applyApplication();
  await apply(await manifest('traefik'));
  await apply(await manifest('ingress'));
  await kubectl(['rollout', 'status', 'deployment/app', '--timeout=180s'], { timeoutMs: 190_000 });
  await kubectl(['rollout', 'status', 'deployment/traefik', '--timeout=180s'], { timeoutMs: 190_000 });

  let forwarding = forwardings.get(namespace);
  if (testing && (!forwarding || forwarding.exitCode !== null || forwarding.signalCode !== null)) {
    assertDeploymentDeadline();
    const args = ['--kubeconfig', kubeconfig, '--context', context, '--namespace', namespace,
      'port-forward', '--address=127.0.0.1', 'service/traefik', `${httpPort}:80`, `${httpsPort}:443`];
    forwarding = spawn('kubectl', args, { cwd: root, stdio: 'ignore' });
    forwardings.set(namespace, forwarding);
    forwarding.on('error', () => {});
    const deadline = Date.now() + 15_000;
    while (true) {
      assertDeploymentDeadline();
      assert.equal(forwarding.exitCode, null, 'Traefik port-forward exited.');
      try {
        const net = await import('node:net');
        await new Promise((accept, reject) => { const socket = net.connect({ host: '127.0.0.1', port: httpsPort });
          socket.setTimeout(500); socket.once('connect', () => { socket.destroy(); accept(); });
          socket.once('error', reject); socket.once('timeout', () => { socket.destroy(); reject(new Error('not listening')); }); });
        break;
      } catch { assert.ok(Date.now() < deadline, 'Traefik port-forward deadline.'); await delay(100); }
    }
  }
  await waitForPublicHttps(publicOrigin, tls.caPath);
  async function sql(query, params = []) {
    await assertOwned();
    assert.ok(testing && /test/u.test(database), 'Fault SQL is restricted to the disposable test deployment.');
    const pods = await kubectl(['get', 'pods', '-l', 'app.kubernetes.io/name=courier-route-app', '-o', 'json'], { json: true });
    const pod = pods.items.find((item) => !item.metadata.deletionTimestamp && item.status.phase === 'Running');
    assert.ok(pod, 'An app pod is required for SQL through the application role.');
    const source = `import pg from 'pg';import assert from 'node:assert/strict';let input='';for await(const chunk of process.stdin)input+=chunk;const {query,params,database}=JSON.parse(input);const url=new URL(process.env.DATABASE_URL);assert.equal(url.hostname,'postgres');assert.equal(url.port,'5432');assert.equal(decodeURIComponent(url.pathname.slice(1)),database);assert.match(database,/test/);const client=new pg.Client({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:3000,statement_timeout:5000});await client.connect();try{const r=await client.query('SELECT current_database() AS db,current_user AS role,rolsuper,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=current_user');assert.equal(r.rows[0].db,database);assert.equal(r.rows[0].role,'courier_route');assert.equal(r.rows[0].rolsuper,false);assert.equal(r.rows[0].rolcreatedb,false);assert.equal(r.rows[0].rolcreaterole,false);const result=await client.query(query,params);console.log(JSON.stringify((Array.isArray(result)?result.at(-1):result).rows??[]));}finally{await client.end();}`;
    return JSON.parse(await kubectl(['exec', '-i', pod.metadata.name, '-c', 'app', '--', 'node', '--input-type=module', '-e', source],
      { input: JSON.stringify({ query, params, database }), timeoutMs: 20_000 }));
  }
  async function killAppProcess(podName) {
    assert.ok(testing, 'Abrupt process faults are limited to a disposable test deployment.');
    await assertOwned();
    const pod = await kubectl(['get', 'pod', podName, '-o', 'json'], { json: true });
    assert.equal(pod.metadata.namespace, namespace);
    assert.equal(pod.metadata.labels['courier-route.local/owner-id'], ownerId);
    assert.equal(pod.metadata.labels['app.kubernetes.io/name'], 'courier-route-app');
    assert.equal(pod.spec.containers.find((value) => value.name === 'app')?.image, image);
    assert.equal(pod.spec.nodeName, `${cluster}-control-plane`);
    const node = JSON.parse(await run('docker', ['inspect', pod.spec.nodeName], { env: dockerEnvironment }))[0];
    assert.equal(node.Config.Labels['io.x-k8s.kind.cluster'], cluster);
    const container = pod.status.containerStatuses.find((value) => value.name === 'app');
    assert.ok(container?.state?.running);
    assert.match(container.containerID, /^containerd:\/\/[0-9a-f]{64}$/u);
    const id = container.containerID.slice('containerd://'.length);
    const runtime = JSON.parse(await run('docker', ['exec', pod.spec.nodeName, 'ctr', '--namespace', 'k8s.io', 'containers', 'info', id], { env: dockerEnvironment }));
    assert.equal(runtime.Labels['io.kubernetes.pod.namespace'], namespace);
    assert.equal(runtime.Labels['io.kubernetes.pod.uid'], pod.metadata.uid);
    assert.equal(runtime.Labels['io.kubernetes.container.name'], 'app');
    await run('docker', ['exec', pod.spec.nodeName, 'ctr', '--namespace', 'k8s.io', 'tasks', 'kill', '--signal', 'SIGKILL', '--all', id],
      { env: dockerEnvironment, timeoutMs: 10_000 });
  }
  async function cleanup() {
    return withoutDeploymentDeadline(async () => {
      await closeForwarding(namespace);
      if (!testing) return;
      assert.match(namespace, /^courier-route-test-[a-z0-9-]+$/u);
      await assertOwned();
      await kubectl(['delete', 'namespace', namespace, '--wait=true', '--timeout=120s'], { timeoutMs: 130_000 });
      await rm(directory, { recursive: true });
    });
  }
  const repeatDeploy = async () => {
    await assertOwned();
    return provision({ state, namespace, ownerId, httpPort, httpsPort, image, testing, autoscaling });
  };
  const metrics = async () => ({
    apiService: await kubectl(['get', 'apiservice', 'v1beta1.metrics.k8s.io', '-o', 'json'], { json: true }),
    nodes: await kubectl(['get', '--raw', '/apis/metrics.k8s.io/v1beta1/nodes'], { json: true }),
    pods: await kubectl(['get', '--raw', `/apis/metrics.k8s.io/v1beta1/namespaces/${namespace}/pods`], { json: true }),
  });
  const forwardingInfo = () => {
    const child = forwardings.get(namespace);
    return child ? { pid: child.pid ?? null, exitCode: child.exitCode, signalCode: child.signalCode } : null;
  };
  return { kubeconfig, context, namespace, ownerId, httpsOrigin: publicOrigin, httpOrigin: `http://localhost:${httpPort}`,
    caPath: tls.caPath, image, autoscaling, kubectl, sql, killAppProcess, assertOwned, cleanup,
    repeatDeploy, stop: () => stopNamespace(kubectl, namespace, ownerId), start: repeatDeploy, metrics, forwardingInfo };
}

export async function provisionTestDeployment({ namespace, ownerId, httpPort, httpsPort, autoscaling = false } = {}) {
  assert.match(namespace, /^courier-route-test-[a-z0-9-]+$/u);
  assert.match(ownerId, /^[0-9a-f-]{36}$/u);
  const state = await clusterState();
  httpPort ??= await availablePort(); httpsPort ??= await availablePort();
  assert.notEqual(httpPort, httpsPort);
  const image = await imageName();
  await loadOwnedImage(state, image);
  try { return await provision({ state, namespace, ownerId, httpPort, httpsPort, image, testing: true, autoscaling }); }
  catch (error) {
    await withoutDeploymentDeadline(async () => {
      await closeForwarding(namespace);
      const kubectl = kubectlFor(namespace);
      const value = await kubectl(['get', 'namespace', namespace, '--ignore-not-found', '-o', 'json']);
      if (value.trim()) {
        const metadata = JSON.parse(value).metadata;
        assert.equal(metadata.labels['courier-route.local/owner-id'], ownerId, 'Failed provisioning cleanup refuses a foreign namespace.');
        assert.equal(metadata.labels['app.kubernetes.io/managed-by'], managedLabel);
        await kubectl(['delete', 'namespace', namespace, '--wait=true', '--timeout=120s'], { timeoutMs: 130_000 });
        await rm(join(local, namespace), { recursive: true, force: true });
      }
    });
    throw error;
  }
}

/** This is a local operator action, using the explicitly owned kubeconfig.
 * The HTTP ServiceAccount has no exec or role mutation permission. */
export async function assignDeploymentRole({ namespace = 'courier-route', ownerId, username, role } = {}) {
  assert.match(username ?? '', /^[A-Za-z0-9_-]{3,32}$/u, 'Use a valid existing login.');
  assert.ok(role === 'admin' || role === 'user', 'Role must be admin or user.');
  assert.ok(namespace === 'courier-route' || /^courier-route-test-[a-z0-9-]+$/u.test(namespace), 'Use an owned app namespace.');
  const state = await clusterState();
  await assertClusterOwnership(state);
  if (namespace === 'courier-route') {
    assert.ok(ownerId === undefined || ownerId === state.ownerId, 'The demo owner must match its local record.');
    ownerId = state.ownerId;
  }
  assert.match(ownerId ?? '', /^[0-9a-f-]{36}$/u, 'A test namespace needs its exact owner ID.');
  const kubectl = kubectlFor(namespace);
  const ownedNamespace = await kubectl(['get', 'namespace', namespace, '-o', 'json'], { json: true });
  assertObjectOwner(ownedNamespace, { namespace: undefined, ownerId, kind: 'Namespace', name: namespace });
  const app = await kubectl(['get', 'deployment', 'app', '-o', 'json'], { json: true });
  assertObjectOwner(app, { namespace, ownerId, kind: 'Deployment', name: 'app' });
  const image = app.spec.template.spec.containers.find((container) => container.name === 'app')?.image;
  assert.match(image ?? '', /^courier-route:block07-[0-9a-f]{16}$/u, 'Only the owned compiled app image may run the role CLI.');
  const pods = await kubectl(['get', 'pods', '-l', 'app.kubernetes.io/name=courier-route-app', '-o', 'json'], { json: true });
  const pod = pods.items.find((value) => !value.metadata.deletionTimestamp && value.status?.phase === 'Running'
    && value.status?.conditions?.some((condition) => condition.type === 'Ready' && condition.status === 'True')
    && value.metadata.labels?.['courier-route.local/owner-id'] === ownerId
    && value.metadata.labels?.['app.kubernetes.io/managed-by'] === managedLabel
    && value.spec.nodeName === `${cluster}-control-plane`
    && value.spec.containers.find((container) => container.name === 'app')?.image === image);
  assert.ok(pod, 'A current Ready app process is required for the operator role CLI.');
  const reference = pod.metadata.ownerReferences?.find((value) => value.controller && value.kind === 'ReplicaSet');
  assert.ok(reference, 'The target pod must belong to an app ReplicaSet.');
  const replicaSet = await kubectl(['get', 'replicaset', reference.name, '-o', 'json'], { json: true });
  assert.equal(replicaSet.metadata.uid, reference.uid);
  assert.ok(replicaSet.metadata.ownerReferences?.some((value) => value.controller && value.kind === 'Deployment'
    && value.name === 'app' && value.uid === app.metadata.uid), 'The target pod must belong to the owned Deployment.');
  return (await kubectl(['exec', pod.metadata.name, '-c', 'app', '--', 'node', '/app/dist/server/admin-role.js',
    '--username', username, '--role', role], { timeoutMs: 20_000 })).trim();
}

async function main(command) {
  if (command === 'preflight') { console.log(JSON.stringify(await preflight(), null, 2)); return; }
  if (command === 'image') { console.log(await buildImage()); return; }
  if (command === 'role') {
    const args = process.argv.slice(3);
    const values = new Map();
    for (let index = 0; index < args.length; index += 2) {
      const key = args[index]; const value = args[index + 1];
      assert.ok((key === '--username' || key === '--role') && value && !values.has(key), 'Use --username LOGIN --role admin|user.');
      values.set(key, value);
    }
    console.log(await assignDeploymentRole({ username: values.get('--username'), role: values.get('--role') }));
    return;
  }
  const state = await clusterState({ create: command === 'up' });
  const kubectl = kubectlFor('courier-route');
  if (command === 'status') {
    console.log(await kubectl(['get', 'deployment,statefulset,pod,service,ingress,pvc,job,hpa', '-o', 'wide']));
    console.log(await kubectl(['get', 'apiservice', 'v1beta1.metrics.k8s.io', '-o', 'wide']));
    console.log(await kubectl(['top', 'pods', '--containers']));
    return;
  }
  if (command === 'stop') {
    await stopNamespace(kubectl, 'courier-route', state.ownerId);
    console.log('HPA призупинено; застосунок, Traefik і PostgreSQL зупинено; кластер, Metrics Server та PVC збережено.'); return;
  }
  assert.equal(command, 'up', 'Commands: preflight, image, up, status, stop, role');
  const image = await buildImage();
  await loadOwnedImage(state, image);
  const deployment = await provision({ state, namespace: 'courier-route', ownerId: state.ownerId,
    httpPort: state.httpPort, httpsPort: state.httpsPort, image });
  console.log(JSON.stringify({ origin: deployment.httpsOrigin, redirect: deployment.httpOrigin,
    image, caPath: deployment.caPath, context, namespace: deployment.namespace }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv[2] ?? 'preflight').catch((error) => { console.error(safe(error.message)); process.exitCode = 1; });
}

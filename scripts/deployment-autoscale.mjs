
import assert from 'node:assert/strict';

const ownerLabel = 'courier-route.local/owner-id';
const managedLabel = 'courier-route-local';
const lastAppliedKey = 'kubectl.kubernetes.io/last-applied-configuration';
const annotationPath = '/metadata/annotations/kubectl.kubernetes.io~1last-applied-configuration';

export function assertObjectOwner(object, { namespace, ownerId, kind, name }) {
  assert.match(ownerId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu,
    'An explicit deployment owner UUID is required.');
  assert.ok(typeof kind === 'string' && kind.length > 0 && typeof name === 'string' && name.length > 0,
    'An explicit object kind and name are required.');
  assert.equal(object?.kind, kind, 'Unexpected Kubernetes object kind.');
  assert.equal(object?.metadata?.name, name, 'Unexpected Kubernetes object name.');
  assert.equal(object?.metadata?.namespace, namespace, 'Unexpected Kubernetes object namespace.');
  assert.equal(object?.metadata?.labels?.['app.kubernetes.io/managed-by'], managedLabel,
    'Refusing to change an object managed outside this project.');
  assert.equal(object?.metadata?.labels?.[ownerLabel], ownerId,
    'Refusing to change an object owned by another deployment.');
}

export function replicaHandoffPatch(live) {
  const encoded = live?.metadata?.annotations?.[lastAppliedKey];
  if (encoded === undefined) return null;
  assert.equal(typeof encoded, 'string', 'Deployment last-applied annotation must be text.');
  let previous;
  try { previous = JSON.parse(encoded); }
  catch { throw new Error('Deployment last-applied annotation is malformed; ownership was not changed.'); }
  assert.ok(previous && typeof previous === 'object' && !Array.isArray(previous),
    'Deployment last-applied annotation must be an object.');
  if (!previous.spec || !Object.hasOwn(previous.spec, 'replicas')) return null;
  delete previous.spec.replicas;
  return [
    { op: 'test', path: annotationPath, value: encoded },
    { op: 'replace', path: annotationPath, value: `${JSON.stringify(previous)}\n` },
  ];
}

export function appApplyPlan(manifest, live, { autoscaling, namespace, ownerId }) {
  const result = structuredClone(manifest);
  const deployment = result.items.find((item) => item.kind === 'Deployment' && item.metadata.name === 'app');
  assert.ok(deployment, 'The application Deployment is required.');
  assert.equal(deployment.metadata.namespace, namespace);
  if (live) assertObjectOwner(live, { namespace, ownerId, kind: 'Deployment', name: 'app' });
  const bootstrap = !live || live.spec?.replicas === 0;
  if (!autoscaling || bootstrap) deployment.spec.replicas = 2;
  else delete deployment.spec.replicas;
  return { manifest: result, bootstrap, handoffPatch: autoscaling && live ? replicaHandoffPatch(live) : null };
}

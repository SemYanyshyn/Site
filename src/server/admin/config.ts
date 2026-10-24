import { ADMIN_UUID } from '../../shared/admin.js';

export const ADMIN_LIMITS = Object.freeze({
  requestMs: 8_000, providerMs: 2_000, providerBytes: 2 * 1024 * 1024,
  cacheMs: 5_000, sampleMaxAgeMs: 45_000, maxPods: 100,
  maxExecutors: 10_000, recentSeconds: 60, recentLimit: 100,
});
export interface AdminConfig {
  enabled: boolean;
  namespace: string | null;
  ownerId: string | null;
}
export function readAdminConfig(environment: NodeJS.ProcessEnv = process.env): AdminConfig {
  const enabled = environment.ADMIN_KUBERNETES_ENABLED ?? 'false';
  if (!['true', 'false'].includes(enabled)) throw new Error('ADMIN_KUBERNETES_ENABLED має бути true або false.');
  if (enabled === 'false') return { enabled: false, namespace: null, ownerId: null };
  const namespace = environment.POD_NAMESPACE;
  const ownerId = environment.ADMIN_CLUSTER_OWNER_ID;
  if (!namespace || namespace.length > 63 || !/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/.test(namespace)
    || !ownerId || !ADMIN_UUID.test(ownerId)) {
    throw new Error('Моніторинг Kubernetes потребує коректних POD_NAMESPACE та ADMIN_CLUSTER_OWNER_ID.');
  }
  return { enabled: true, namespace, ownerId };
}

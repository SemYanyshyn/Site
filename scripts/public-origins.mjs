export function deploymentAppOrigins(localOrigin, additional) {
  const origins = new Set([localOrigin]);
  if (additional === undefined || additional === '') return localOrigin;
  for (const entry of additional.split(',')) {
    try {
      const url = new URL(entry.trim());
      if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash
        || url.hostname.includes('*') || url.hostname === 'localhost' || url.hostname.endsWith('.localhost')) throw new Error();
      origins.add(url.origin);
    } catch { throw new Error('COURIER_ADDITIONAL_APP_ORIGINS потребує точних HTTPS origins без шляхів або облікових даних.'); }
  }
  return [...origins].join(',');
}

export function ownedTunnelProcess(state, identity) {
  return Number.isInteger(state?.pid) && state.pid > 1 && typeof state.binary === 'string'
    && typeof state.started === 'string' && state.started.length > 0
    && identity?.started === state.started && identity.command.includes(state.binary)
    && identity.command.includes('tunnel') && identity.command.includes('--url https://localhost:');
}

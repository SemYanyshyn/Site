
export function normalizeApiBase(value: string | undefined): string {
  if (value === undefined || value === '') return '';
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (value !== value.trim() || url.protocol !== 'https:' || url.username || url.password
      || url.pathname !== '/' || url.search || url.hash || host === 'localhost' || host.endsWith('.localhost')
      || host.endsWith('.local') || host === '[::1]' || host === '0.0.0.0' || /^127\./u.test(host)) throw new Error();
    return url.origin;
  } catch {
    throw new Error('VITE_API_BASE_URL має бути публічним HTTPS origin без шляху, параметрів або облікових даних.');
  }
}

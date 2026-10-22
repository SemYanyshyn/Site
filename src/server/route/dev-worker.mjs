// The worker receives no parent preload arguments or environment. Register the
// existing development loader explicitly so its .js imports resolve .ts files.
import { register } from 'tsx/esm/api';

register();
await import('./worker.ts');

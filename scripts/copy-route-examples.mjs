import { cpSync } from 'node:fs';

cpSync(new URL('../examples/', import.meta.url), new URL('../dist/examples/', import.meta.url), { recursive: true });

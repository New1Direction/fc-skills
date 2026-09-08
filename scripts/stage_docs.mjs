import { cp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
await rm(new URL('out/', root), { recursive: true, force: true });
await cp(new URL('docs-site/out/', root), new URL('out/', root), { recursive: true });
console.log(`Static documentation staged at ${fileURLToPath(new URL('out/', root))}`);

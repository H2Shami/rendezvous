import { build } from 'esbuild';
await build({ entryPoints: ['client/cli.js'], bundle: true, platform: 'node', target: 'node22', format: 'esm', outfile: 'dist/client.mjs', legalComments: 'inline' });
console.log('Built standalone dist/client.mjs');

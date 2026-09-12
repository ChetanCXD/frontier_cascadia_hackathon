import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';

const id = process.argv[2];
if (!/^[0-9a-f-]{36}$/i.test(id ?? '')) {
  console.error('Usage: node scripts/save-demo.mjs <completed-session-uuid>');
  process.exit(2);
}
const dataDir = resolve(process.env.DATA_DIR || 'data/sessions');
const input = resolve(dataDir, `session-${id}.json`);
const output = resolve(dataDir, '..', 'demo-session.json');
const state = JSON.parse(await readFile(input, 'utf8'));
if (state?.session?.status !== 'COMPLETE' || !state.report || !state.sources?.length) {
  throw new Error('Only a completed session with real retrieved sources and a report can be saved as the demo.');
}
state.session.metadata = { ...(state.session.metadata ?? {}), demo: true, savedAt: new Date().toISOString() };
state.session.updatedAt = new Date().toISOString();
await mkdir(dirname(output), { recursive: true });
const temporary = `${output}.${process.pid}.${randomUUID()}.tmp`;
await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
await rename(temporary, output);
console.log(`Saved completed real session ${id} as ${output}`);

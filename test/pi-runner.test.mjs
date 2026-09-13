import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PiProcessError, PiResearchRunner } from '../src/research/pi-runner.mjs';

const url = 'https://receipt.example/article';
const excerpt = 'A retrieved source reports measurable improvement after twelve weeks.';
const final = JSON.stringify({
  role: 'RESEARCHER', queries: ['evidence query'],
  sources: [{ url, title: 'Receipt source', publisher: 'Receipt Example', excerpt, sourceType: 'web' }],
  claims: [{ text: 'The intervention improves outcomes.' }],
  edges: [{ claimText: 'The intervention improves outcomes.', sourceUrl: url, type: 'SUPPORTS', confidence: 80, quote: 'measurable improvement after twelve weeks' }],
  contradictions: [], qualifications: [], followUpReasons: [],
  assessments: [{ claimText: 'The intervention improves outcomes.', status: 'SUPPORTED', evidenceStrength: 80, citations: [url] }],
  finalConclusion: 'The retrieved source supports the claim.',
});

async function setup(mode = 'valid') {
  const root = await mkdtemp(join('/tmp', 'claimlens-pi-runner-'));
  const projectDir = join(root, 'project'); const extension = join(root, 'extension.ts'); const executable = join(root, 'pi');
  await (await import('node:fs/promises')).mkdir(projectDir);
  await writeFile(extension, '// test extension');
  const body = mode === 'valid'
    ? `if (process.argv.includes('--version')) { console.log('0.85.1'); process.exit(0); }\nif (process.argv.includes('auth')) { console.log(JSON.stringify({status:'ready',authType:'oauth'})); process.exit(0); }\nconst start = JSON.stringify({type:'tool_execution_start',toolCallId:'search-1',toolName:'web_search',args:{queries:['evidence query'],includeContent:true,workflow:'none'}});\nprocess.stdout.write(start.slice(0, 17)); setTimeout(() => { process.stdout.write(start.slice(17)+'\\n'); console.log(JSON.stringify({type:'tool_execution_end',toolCallId:'search-1',toolName:'web_search',result:{content:[{type:'text',text:${JSON.stringify(url+' '+excerpt)}}]},isError:false})); console.log(JSON.stringify({type:'tool_execution_start',toolCallId:'read-1',toolName:'get_search_content',args:{url:${JSON.stringify(url)}}})); console.log(JSON.stringify({type:'tool_execution_end',toolCallId:'read-1',toolName:'get_search_content',result:{content:[{type:'text',text:${JSON.stringify(excerpt)}}],details:{url:${JSON.stringify(url)}}},isError:false})); console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:${JSON.stringify(final)}}]}})); }, 5);`
    : `if (process.argv.includes('--version')) { console.log('0.85.1'); process.exit(0); }\nif (process.argv.includes('auth')) { console.log(JSON.stringify({status:'ready'})); process.exit(0); }\nconsole.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:${JSON.stringify(final)}}]}}));`;
  await writeFile(executable, `#!/usr/bin/env node\n${body}\n`); await chmod(executable, 0o755);
  return { root, projectDir, extension, executable };
}

test('Pi runner uses isolated arguments and counts split JSONL web activity', async () => {
  const paths = await setup();
  try {
    const runner = new PiResearchRunner({ ...paths, timeoutMs: 5_000, maxSearchCalls: 2 });
    const progress = [];
    const packet = await runner.run({ role: 'RESEARCHER', question: 'Does the intervention improve outcomes?', onProgress: (event) => progress.push(event) });
    assert.equal(packet.provider, 'pi'); assert.equal(packet.searchCalls, 1);
    assert.ok(progress.some((event) => event.kind === 'web_search'));
    assert.ok(progress.some((event) => event.kind === 'get_search_content'));
    assert.deepEqual(packet.observedUrls, [url]);
  } finally { await rm(paths.root, { recursive: true, force: true }); }
});

test('Pi runner fails closed when no successful web-search receipt exists', async () => {
  const paths = await setup('no-search');
  try {
    const runner = new PiResearchRunner({ ...paths, timeoutMs: 5_000 });
    await assert.rejects(() => runner.run({ role: 'RESEARCHER', question: 'Does the intervention improve outcomes?' }), (error) => error instanceof PiProcessError && error.code === 'web_search_not_used');
  } finally { await rm(paths.root, { recursive: true, force: true }); }
});

test('Pi runner reports a missing executable without fallback', async () => {
  const paths = await setup();
  try {
    const runner = new PiResearchRunner({ ...paths, executable: join(paths.root, 'missing-pi') });
    await assert.rejects(() => runner.run({ role: 'RESEARCHER', question: 'Does the intervention improve outcomes?' }), /not found/);
  } finally { await rm(paths.root, { recursive: true, force: true }); }
});

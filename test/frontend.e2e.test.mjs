import test from 'node:test';
import assert from 'node:assert/strict';
import { access, cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { accessSync, constants } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClaimLensServer } from '../src/server.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/home/chetan/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome',
  '/usr/bin/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium-browser',
].filter(Boolean);
const chromePath = CHROME_CANDIDATES.find((candidate) => { try { accessSync(candidate, constants.X_OK); return true; } catch { return false; } });
const hasWebSocket = typeof globalThis.WebSocket === 'function';
const e2eAvailable = Boolean(chromePath && hasWebSocket);
const wait = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));

async function waitForFile(path, timeoutMs = 12_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { try { return await readFile(path, 'utf8'); } catch { await wait(100); } }
  throw new Error(`Timed out waiting for ${path}`);
}

async function openCdp(port) {
  const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const tab = tabs.find((item) => item.type === 'page');
  if (!tab) throw new Error('Chromium did not expose a page target');
  const socket = new WebSocket(tab.webSocketDebuggerUrl);
  let nextId = 0;
  const pending = new Map();
  const events = [];
  socket.onmessage = (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id !== undefined) { pending.get(message.id)?.(message); pending.delete(message.id); }
    else events.push(message);
  };
  await new Promise((resolveOpen, rejectOpen) => { socket.onopen = resolveOpen; socket.onerror = rejectOpen; });
  const command = (method, params = {}) => new Promise((resolveCommand, rejectCommand) => {
    const id = ++nextId;
    pending.set(id, (message) => message.error ? rejectCommand(new Error(JSON.stringify(message.error))) : resolveCommand(message));
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const response = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (response.result?.exceptionDetails) throw new Error(response.result.exceptionDetails.text || 'Browser evaluation failed');
    return response.result?.result?.value;
  };
  return { socket, command, evaluate, events };
}

async function browserSmoke() {
  const temp = await mkdtemp(join(tmpdir(), 'claimlens-browser-e2e-'));
  let browser;
  const dataDir = join(temp, 'data', 'sessions');
  const saved = JSON.parse(await readFile(join(ROOT, 'data', 'demo-session.json'), 'utf8'));
  const { server } = await createClaimLensServer({ dataDir, publicDir: join(ROOT, 'public') });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const port = server.address().port;
  await cp(join(ROOT, 'data', 'demo-session.json'), join(temp, 'data', 'demo-session.json'));
  await cp(join(ROOT, 'data', 'demo-session.json'), join(dataDir, `session-${saved.session.id}.json`));
  const profile = join(temp, 'chrome-profile');
  browser = spawn(chromePath, ['--headless', '--no-sandbox', '--disable-gpu', `--user-data-dir=${profile}`, '--remote-debugging-port=0', 'about:blank'], { stdio: 'ignore', detached: true });
  try {
    const activePort = Number((await waitForFile(join(profile, 'DevToolsActivePort'))).split('\n')[0]);
    const cdp = await openCdp(activePort);
    const { command, evaluate, events } = cdp;
    await command('Runtime.enable'); await command('Log.enable'); await command('Page.enable');
    const waitFor = async (expression, timeoutMs = 15_000) => { const end = Date.now() + timeoutMs; while (Date.now() < end) { if (await evaluate(expression)) return; await wait(100); } throw new Error(`Browser condition timed out: ${expression}`); };
    await command('Page.navigate', { url: `http://127.0.0.1:${port}/` });
    await waitFor("document.querySelector('#question-form')");
    const landing = await evaluate("({ heading: document.querySelector('h1')?.textContent.trim(), input: !!document.querySelector('#question') })");
    assert.equal(landing.input, true);
    assert.match(landing.heading, /prove itself wrong/i);
    await command('Page.navigate', { url: `http://127.0.0.1:${port}/#/research/${saved.session.id}` });
    await waitFor("document.querySelector('.workspace')");
    const graph = await evaluate("({ nodes: document.querySelectorAll('.graph-node').length, claims: document.querySelectorAll('.node-claim').length, sources: document.querySelectorAll('.node-source').length, question: document.querySelectorAll('.node-question').length, trace: document.querySelectorAll('.timeline-group').length })");
    assert.ok(graph.nodes >= 10); assert.ok(graph.claims >= 1); assert.ok(graph.sources >= 1); assert.equal(graph.question, 1); assert.ok(graph.trace >= 1);
    const mouseClick = async (selector) => {
      const clicked = await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window })); return true; })()`);
      assert.equal(clicked, true, `missing clickable ${selector}`);
    };
    await mouseClick('.node-claim'); await waitFor("document.querySelector('.inspector-panel')?.textContent.includes('EVIDENCE STRENGTH')");
    const claimInspector = await evaluate("({ support: document.querySelector('.inspector-panel')?.textContent.includes('Supporting sources'), contradiction: document.querySelector('.inspector-panel')?.textContent.includes('Contradicting sources') })");
    assert.equal(claimInspector.support, true); assert.equal(claimInspector.contradiction, true);
    await mouseClick('.node-source'); await waitFor("document.querySelector('.inspector-panel')?.textContent.includes('Excerpt')");
    const sourceInspector = await evaluate("({ excerpt: document.querySelector('.inspector-panel')?.textContent.includes('Excerpt'), url: document.querySelector('.inspector-panel')?.textContent.includes('Open source'), lineage: document.querySelector('.inspector-panel')?.textContent.includes('Lineage') })");
    assert.deepEqual(sourceInspector, { excerpt: true, url: true, lineage: true });
    await evaluate("document.querySelector('[data-action=report]')?.click()"); await waitFor("document.querySelector('.report-view')");
    const report = await evaluate("({ conclusion: document.querySelector('.report-view')?.textContent.includes('EXECUTIVE CONCLUSION'), findings: document.querySelector('.report-view')?.textContent.includes('Findings'), citationLinks: document.querySelectorAll('.report-view a').length })");
    assert.equal(report.conclusion, true); assert.equal(report.findings, true); assert.ok(report.citationLinks > 0);
    await command('Page.reload', { ignoreCache: true }); await waitFor("document.querySelector('.workspace')");
    const refresh = await evaluate("({ workspace: !!document.querySelector('.workspace'), nodes: document.querySelectorAll('.graph-node').length })");
    assert.equal(refresh.workspace, true); assert.ok(refresh.nodes >= graph.nodes);
    await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await wait(300);
    const mobile = await evaluate("({ viewport: innerWidth, body: document.body.scrollWidth })");
    assert.equal(mobile.viewport, 390); assert.ok(mobile.body <= 390);
    await command('Emulation.clearDeviceMetricsOverride'); cdp.socket.close();
    const exceptions = events.filter((event) => event.method === 'Runtime.exceptionThrown');
    const consoleErrors = events.filter((event) => event.method === 'Runtime.consoleAPICalled' && ['error', 'assert'].includes(event.params.type));
    const logErrors = events.filter((event) => event.method === 'Log.entryAdded' && event.params.entry.level === 'error');
    assert.equal(exceptions.length, 0, JSON.stringify(exceptions)); assert.equal(consoleErrors.length, 0, JSON.stringify(consoleErrors)); assert.equal(logErrors.length, 0, JSON.stringify(logErrors));
    return { landing, graph, claimInspector, sourceInspector, report, refresh, mobile, browserErrors: 0 };
  } finally {
    if (browser.exitCode === null) {
      try { process.kill(-browser.pid, 'SIGTERM'); } catch { browser.kill('SIGTERM'); }
      await Promise.race([new Promise((resolveExit) => browser.once('exit', resolveExit)), wait(2_000)]);
      if (browser.exitCode === null) { try { process.kill(-browser.pid, 'SIGKILL'); } catch { browser.kill('SIGKILL'); } await wait(200); }
    }
    await new Promise((resolveClose) => server.close(resolveClose));
    await rm(temp, { recursive: true, force: true });
  }
}

test('browser smoke: landing, graph, inspectors, report, refresh and mobile layout', { skip: !e2eAvailable && `Chromium/WebSocket unavailable${chromePath ? '' : ' (set CHROME_PATH to run)'}` }, async () => {
  const result = await browserSmoke();
  assert.ok(result.graph.nodes > 0);
});

import { spawn } from 'node:child_process';
import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { extractText, extractUrls, normalizeObservedUrl, PiOutputError, validatePiResult } from './pi-schema.mjs';

export const DEFAULT_PI_CONFIG = Object.freeze({
  executable: 'pi',
  projectDir: '/home/chetan/pi_frontier',
  timeoutMs: 1_800_000,
  maxConcurrentWorkers: 1,
  maxSearchCalls: 8,
  maxContentCalls: 32,
  provider: 'openai-codex',
  model: 'gpt-5.6-luna',
  thinking: 'xhigh',
  webSearchExtension: join(homedir(), '.pi/agent/npm/node_modules/pi-web-access/index.ts'),
});

export class PiConfigurationError extends Error {
  constructor(message, code = 'pi_configuration_error') { super(message); this.name = 'PiConfigurationError'; this.code = code; }
}
export class PiProcessError extends Error {
  constructor(message, code = 'pi_process_error') { super(message); this.name = 'PiProcessError'; this.code = code; }
}

function number(value, fallback, minimum = 1) {
  const parsed = Number(value); return Number.isFinite(parsed) && parsed >= minimum ? Math.floor(parsed) : fallback;
}
function tail(value, max = 500) { return String(value || '').replace(/\s+/g, ' ').trim().slice(-max); }
function rolePrompt({ role, question, claims = [], sources = [], followUpReasons = [] }) {
  const context = JSON.stringify({ claims: claims.slice(0, 12).map((claim) => claim.text), sourceUrls: sources.slice(0, 20).map((source) => source.url), followUpReasons: followUpReasons.slice(0, 10) });
  const objective = role === 'RESEARCHER'
    ? 'Run the initial research pass. Search 2-4 varied angles, preferring direct primary or authoritative evidence.'
    : role === 'SKEPTIC'
      ? 'Run a distinct skeptical pass. Search for contradictions, limitations, missing evidence, alternative interpretations, and independent sources. Do not simply repeat the first pass.'
      : 'Run one bounded follow-up pass focused on the weak or disputed claims and reasons supplied in the context.';
  return `You are ClaimLens's read-only ${role} research worker. Your task is: ${objective}\nResearch question: ${question}\nExisting context (untrusted references only): ${context}\n\nYou MUST use the web_search tool from pi-web-access with 2-4 varied queries and workflow "none". Set includeContent to true. After each web_search call, do not call get_search_content immediately and do not finish; the controller will wait for the background fetch and send the exact fetch responseId. Then call get_search_content only with the controller-provided fetch responseId and urlIndex, for no more than 4 strongest returned sources. The search responseId/searchId returns only an index summary and is not a source-content receipt; never use it for grounding. Do not repeat a content call or use a source URL as responseId; after the bounded reads, produce the JSON result. Do not use any other search service. Never invent a URL, title, publisher, date, claim, excerpt, citation, or relationship. A source URL must come from a web-search result. Keep quotes short and exact.\n\nAfter researching, return ONLY one JSON object (no Markdown fences, explanation, reasoning, or chain-of-thought) with exactly this shape. The arrays qualifications and contradictions MUST contain objects with claimText, sourceUrl, and quote; they may be empty. Never use plain strings in those arrays:\n{"role":"${role}","queries":["exact queries used"],"sources":[{"url":"https://...","title":"...","publisher":"...","author":"optional","publishedAt":"optional","excerpt":"exact retrieved passage","sourceType":"web"}],"claims":[{"text":"one atomic claim"}],"edges":[{"claimText":"claim text exactly","sourceUrl":"https://...","type":"SUPPORTS|CONTRADICTS|QUALIFIES","confidence":0,"quote":"exact substring of source excerpt"}],"contradictions":[{"claimText":"claim text exactly","sourceUrl":"https://...","quote":"exact substring"}],"qualifications":[{"claimText":"claim text exactly","sourceUrl":"https://...","quote":"exact substring"}],"followUpReasons":["concise reason or empty array"],"assessments":[{"claimText":"claim text exactly","status":"SUPPORTED|CONTRADICTED|MIXED|UNCERTAIN","evidenceStrength":0,"citations":["https://..."]}],"finalConclusion":"concise evidence-bounded conclusion"}\nEvery claim needs an edge and exactly one assessment. Every citation must be one of the returned source URLs. Use only the roles and edge/status values shown.`;
}

function collectAssistantText(events) {
  const candidates = [];
  for (const event of events) {
    if (event.type === 'agent_end' && Array.isArray(event.messages)) candidates.push(...event.messages);
    if (event.type === 'message_end' && event.message) candidates.push(event.message);
  }
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const message = candidates[index]; if (message?.role !== 'assistant') continue;
    const text = (Array.isArray(message.content) ? message.content : []).filter((part) => part?.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('').trim();
    if (text) return text;
  }
  throw new PiProcessError('Pi returned no final assistant result.', 'missing_pi_result');
}
function parseJsonObject(text) {
  const cleaned = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(cleaned); } catch { /* Find one balanced JSON object without treating braces inside strings as delimiters. */ }
  const start = cleaned.indexOf('{'); if (start < 0) throw new PiOutputError('Pi result did not contain a JSON object.');
  let depth = 0; let quoted = false; let escaped = false;
  for (let index = start; index < cleaned.length; index += 1) {
    const char = cleaned[index];
    if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; continue; }
    if (char === '"') quoted = true; else if (char === '{') depth += 1; else if (char === '}' && --depth === 0) {
      try { return JSON.parse(cleaned.slice(start, index + 1)); } catch { break; }
    }
  }
  throw new PiOutputError('Pi result was not valid JSON.');
}
function parseJsonLines(stdout) {
  const events = [];
  for (const line of String(stdout).split('\n').map((item) => item.trim()).filter(Boolean)) {
    try { const event = JSON.parse(line); if (event && typeof event === 'object') events.push(event); } catch { /* Pi can emit a non-JSON diagnostic; it is never persisted. */ }
  }
  return events;
}
function processResult(child, { timeoutMs, maxOutput = 8_000_000 } = {}) {
  return new Promise((resolveResult, rejectResult) => {
    let stdout = ''; let stderr = ''; let settled = false; let timer;
    const fail = (error) => { if (settled) return; settled = true; clearTimeout(timer); rejectResult(error); };
    const finish = (code, signal) => { if (settled) return; settled = true; clearTimeout(timer); if (code !== 0) return rejectResult(new PiProcessError(`Pi exited unsuccessfully (${signal || code}).`, 'pi_process_failed')); resolveResult({ stdout, stderr }); };
    child.stdout?.on('data', (chunk) => { stdout += chunk; if (stdout.length > maxOutput) { child.kill('SIGKILL'); fail(new PiProcessError('Pi output exceeded the safety limit.', 'pi_output_too_large')); } });
    child.stderr?.on('data', (chunk) => { stderr += chunk; if (stderr.length > maxOutput) stderr = stderr.slice(-maxOutput); });
    child.once('error', (error) => fail(new PiConfigurationError(error.code === 'ENOENT' ? 'Pi executable was not found.' : `Pi could not start: ${error.message}`, error.code === 'ENOENT' ? 'pi_missing' : 'pi_spawn_error')));
    child.once('close', finish);
    timer = setTimeout(() => { child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 1_000).unref(); fail(new PiProcessError(`Pi research exceeded the ${Math.round(timeoutMs / 1000)} second timeout.`, 'pi_timeout')); }, timeoutMs);
  });
}

export { rolePrompt };

export class PiResearchRunner {
  constructor(config = {}) {
    this.config = { ...DEFAULT_PI_CONFIG, ...config, timeoutMs: number(config.timeoutMs, DEFAULT_PI_CONFIG.timeoutMs), maxConcurrentWorkers: number(config.maxConcurrentWorkers, DEFAULT_PI_CONFIG.maxConcurrentWorkers), maxSearchCalls: number(config.maxSearchCalls, DEFAULT_PI_CONFIG.maxSearchCalls), maxContentCalls: number(config.maxContentCalls, DEFAULT_PI_CONFIG.maxContentCalls) };
    this.waiters = []; this.active = 0; this.availability = null;
  }
  async acquire() { if (this.active < this.config.maxConcurrentWorkers) { this.active += 1; return; } await new Promise((resolveAcquire) => this.waiters.push(resolveAcquire)); this.active += 1; }
  release() { this.active = Math.max(0, this.active - 1); this.waiters.shift()?.(); }
  async checkAvailability() {
    if (this.availability) return this.availability;
    this.availability = this._checkAvailability().catch((error) => { this.availability = null; throw error; }); return this.availability;
  }
  async _checkAvailability() {
    let extension;
    try { extension = await stat(this.config.webSearchExtension); } catch { throw new PiConfigurationError(`pi-web-access extension was not found at ${this.config.webSearchExtension}.`, 'web_search_extension_missing'); }
    if (!extension.isFile()) throw new PiConfigurationError('Configured pi-web-access extension is not a file.', 'web_search_extension_invalid');
    try { const directory = await stat(this.config.projectDir); if (!directory.isDirectory()) throw new Error(); } catch { throw new PiConfigurationError(`Pi project directory is unavailable: ${this.config.projectDir}`, 'pi_project_missing'); }
    const version = await this._spawn(['--version'], { timeoutMs: 10_000 });
    if (!version.stdout.trim()) throw new PiConfigurationError('Pi executable did not return a version.', 'pi_invalid_executable');
    let auth;
    try { auth = await this._spawn(['auth', 'check', '--provider', this.config.provider, '--json', '--no-refresh'], { timeoutMs: 30_000 }); }
    catch { throw new PiConfigurationError('Pi Codex authentication check failed.', 'codex_auth_unavailable'); }
    let payload; try { payload = JSON.parse(auth.stdout.trim().split('\n').filter(Boolean).at(-1)); } catch { throw new PiConfigurationError('Pi Codex authentication check returned an invalid response.', 'codex_auth_invalid'); }
    if (payload?.status !== 'ready') throw new PiConfigurationError('Pi OpenAI/Codex subscription authentication is not ready.', 'codex_auth_unavailable');
    return { provider: 'pi', runtime: 'pi', piVersion: tail(version.stdout, 100), authType: payload.authType || 'configured', extension: resolve(this.config.webSearchExtension) };
  }
  async _spawn(args, { timeoutMs }) {
    const child = spawn(this.config.executable, args, { cwd: this.config.projectDir, env: { ...process.env, NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    return processResult(child, { timeoutMs, maxOutput: 1_000_000 });
  }
  async run({ role, question, claims = [], sources = [], followUpReasons = [], maxSearchCalls = this.config.maxSearchCalls, onProgress } = {}) {
    await this.acquire();
    try {
      const available = await this.checkAvailability();
      const args = ['--no-extensions', '--no-skills', '--no-context-files', '--no-session', '--no-approve', '--no-builtin-tools', '--tools', 'web_search,get_search_content', '--extension', this.config.webSearchExtension, '--mode', 'rpc', '--provider', this.config.provider, '--model', this.config.model, '--thinking', this.config.thinking];
      const child = spawn(this.config.executable, args, { cwd: this.config.projectDir, env: { ...process.env, NO_COLOR: '1' }, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
      let stdout = ''; let lineBuffer = ''; const streamedEvents = []; const progressSeen = new Set(); const rpcTimers = new Set();
      let budgetError; let contentBudgetError; let liveSuccessfulContent = 0; let finalJsonSeen = false; let stopPromptSent = false;
      const callArgs = new Map(); const fetchIds = new Set(); const promptedFetchIds = new Set();
      const sendRpc = (command) => { if (!child.stdin?.destroyed) child.stdin.write(`${JSON.stringify(command)}\n`); };
      const scheduleFetchPrompt = (fetchId, delay = 4_000) => {
        if (typeof fetchId !== 'string' || promptedFetchIds.has(fetchId)) return;
        promptedFetchIds.add(fetchId);
        const timer = setTimeout(() => { rpcTimers.delete(timer); sendRpc({ type: 'prompt', streamingBehavior: 'steer', message: `The web_search content fetch is ready now. Retrieve actual source content using get_search_content with responseId exactly ${fetchId} and urlIndex 0 (not the search responseId, not a URL). If a prior call returned an error, retry this exact fetch-id call once. Then retrieve at most three more URLs and return the required JSON object.` }); }, delay);
        rpcTimers.add(timer); timer.unref?.();
      };
      const progressFor = (event) => {
        if (event.type !== 'tool_execution_start' || !['web_search', 'get_search_content'].includes(event.toolName)) return;
        const argsObject = event.args && typeof event.args === 'object' ? event.args : {};
        callArgs.set(event.toolCallId, argsObject);
        if (progressSeen.has(event.toolCallId)) return;
        progressSeen.add(event.toolCallId);
        const queries = Array.isArray(argsObject.queries) ? argsObject.queries : argsObject.query ? [argsObject.query] : [];
        onProgress?.({ kind: event.toolName, query: queries[0] || argsObject.url || argsObject.responseId, queryCount: queries.length, message: event.toolName === 'web_search' ? 'Pi is searching the web.' : 'Pi is reading retrieved source content.' });
        if (event.toolName === 'web_search') sendRpc({ type: 'steer', message: 'When this web_search returns, do not use its suggested search responseId and do not finish yet. Wait for the content-fetch instruction and use that exact fetch responseId with urlIndex 0.' });
      };
      const handleEvent = (event) => {
        if (!event || typeof event !== 'object') return;
        streamedEvents.push(event); progressFor(event);
        if (event.type === 'tool_execution_end' && event.toolName === 'web_search') {
          const fetchId = event.result?.details?.fetchId;
          if (typeof fetchId === 'string') { fetchIds.add(fetchId); scheduleFetchPrompt(fetchId); }
        }
        if (event.type === 'tool_execution_end' && event.toolName === 'get_search_content') {
          const argsObject = callArgs.get(event.toolCallId) || {};
          if (typeof event.result?.details?.url === 'string' && !event.result?.details?.error) {
            liveSuccessfulContent += 1;
            if (!stopPromptSent) {
              stopPromptSent = true;
              sendRpc({ type: 'prompt', streamingBehavior: 'steer', message: 'A source was retrieved successfully. Stop invoking web tools now and immediately return the required JSON object. Use only successfully retrieved source content and exact source URLs; do not wait for or fetch additional sources.' });
            }
          }
          if (typeof argsObject.responseId === 'string' && fetchIds.has(argsObject.responseId) && event.result?.details?.error) scheduleFetchPrompt(argsObject.responseId, 1_000);
        }
        if ((event.type === 'message_end' || event.type === 'agent_end') && !finalJsonSeen) {
          const messages = event.type === 'agent_end' ? event.messages : [event.message];
          const text = messages?.filter((message) => message?.role === 'assistant').flatMap((message) => Array.isArray(message.content) ? message.content : []).filter((part) => part?.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('').trim();
          if (liveSuccessfulContent > 0 && text) { try { finalJsonSeen = Boolean(parseJsonObject(text)); } catch { /* final result may be split across later events */ } }
          if ((finalJsonSeen || liveSuccessfulContent > 0) && event.type === 'agent_end') child.stdin.end();
        }
      };
      const consumeLine = (line) => {
        const trimmed = line.trim(); if (!trimmed) return;
        try { handleEvent(JSON.parse(trimmed)); } catch { /* diagnostics are not research receipts */ }
      };
      child.stdout?.on('data', (chunk) => {
        const text = String(chunk); stdout += text; lineBuffer += text;
        let newline;
        while ((newline = lineBuffer.indexOf('\n')) >= 0) { consumeLine(lineBuffer.slice(0, newline)); lineBuffer = lineBuffer.slice(newline + 1); }
        const starts = streamedEvents.filter((event) => event.type === 'tool_execution_start' && event.toolName === 'web_search').length;
        if (starts > maxSearchCalls) { budgetError = new PiProcessError(`Pi exceeded the ${maxSearchCalls} web-search call limit.`, 'pi_search_budget_exhausted'); child.kill('SIGTERM'); }
        const contentStarts = streamedEvents.filter((event) => event.type === 'tool_execution_start' && event.toolName === 'get_search_content').length;
        if (contentStarts > this.config.maxContentCalls) { contentBudgetError = new PiProcessError(`Pi exceeded the ${this.config.maxContentCalls} retrieved-content call limit.`, 'pi_content_budget_exhausted'); child.kill('SIGTERM'); }
        if (stdout.length > 8_000_000) child.kill('SIGKILL');
      });
      sendRpc({ type: 'prompt', id: 'claimlens-initial', message: rolePrompt({ role, question, claims, sources, followUpReasons }) });
      let output;
      try { output = await processResult(child, { timeoutMs: this.config.timeoutMs }); } catch (error) { if (budgetError) throw budgetError; if (contentBudgetError) throw contentBudgetError; throw error; }
      for (const timer of rpcTimers) clearTimeout(timer);
      if (lineBuffer) consumeLine(lineBuffer);
      // Parse the complete stream again so final validation cannot depend on
      // stdout chunk boundaries and cannot miss the authoritative last result.
      const events = parseJsonLines(output.stdout);
      for (const event of events) progressFor(event);
      const observedUrls = new Set(); const observedText = []; const observedContent = new Map();
      const startedSearches = new Set(); const startedContentReads = new Set(); const successfulSearches = new Set(); const successfulContentReads = new Set();
      for (const event of events) {
        if (event.type === 'tool_execution_start' && event.toolName === 'web_search') startedSearches.add(event.toolCallId);
        if (event.type === 'tool_execution_start' && event.toolName === 'get_search_content') startedContentReads.add(event.toolCallId);
        if (event.type !== 'tool_execution_end' || !['web_search', 'get_search_content'].includes(event.toolName) || event.isError === true) continue;
        const details = event.result && typeof event.result === 'object' && event.result.details && typeof event.result.details === 'object' ? event.result.details : {};
        if (details.error) continue;
        const texts = extractText(event.result);
        const urls = extractUrls(event.result);
        if (event.toolName === 'web_search' && startedSearches.has(event.toolCallId)) { successfulSearches.add(event.toolCallId); for (const item of urls) observedUrls.add(item); }
        if (event.toolName === 'get_search_content' && startedContentReads.has(event.toolCallId) && texts.length && typeof details.url === 'string') {
          const sourceUrl = normalizeObservedUrl(details.url);
          if (!sourceUrl) continue;
          successfulContentReads.add(event.toolCallId); observedUrls.add(sourceUrl); observedContent.set(sourceUrl, [...(observedContent.get(sourceUrl) ?? []), ...texts]);
        }
        observedText.push(...texts);
      }
      if (!successfulSearches.size) throw new PiProcessError('Pi completed without a successful pi-web-search call.', 'web_search_not_used');
      if (!successfulContentReads.size) throw new PiProcessError('Pi completed without reading retrieved pi-web-search content.', 'search_content_not_read');
      const parsed = parseJsonObject(collectAssistantText(events));
      const result = validatePiResult(parsed, { role, observedUrls, observedText, observedContent });
      return { result, provider: available.provider, runtime: available.runtime, model: this.config.model, searchCalls: successfulSearches.size, observedUrlCount: observedUrls.size, observedUrls: [...observedUrls], observedText, observedContent };
    } finally { this.release(); }
  }
}

export function piConfigFromEnv(env = process.env) {
  return {
    executable: env.PI_EXECUTABLE || DEFAULT_PI_CONFIG.executable,
    projectDir: env.PI_PROJECT_DIR || DEFAULT_PI_CONFIG.projectDir,
    timeoutMs: number(env.PI_TIMEOUT_MS, DEFAULT_PI_CONFIG.timeoutMs),
    maxConcurrentWorkers: number(env.PI_MAX_CONCURRENT_WORKERS, DEFAULT_PI_CONFIG.maxConcurrentWorkers),
    maxSearchCalls: number(env.MAX_SEARCH_CALLS, DEFAULT_PI_CONFIG.maxSearchCalls),
    maxContentCalls: number(env.PI_MAX_CONTENT_CALLS, DEFAULT_PI_CONFIG.maxContentCalls),
    provider: env.PI_PROVIDER || DEFAULT_PI_CONFIG.provider,
    model: env.PI_MODEL || DEFAULT_PI_CONFIG.model,
    thinking: env.PI_THINKING || DEFAULT_PI_CONFIG.thinking,
    webSearchExtension: env.PI_WEB_SEARCH_EXTENSION || DEFAULT_PI_CONFIG.webSearchExtension,
  };
}

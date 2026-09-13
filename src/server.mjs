import { createServer as nodeCreateServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { JsonSessionStore } from './domain/store.mjs';
import { findSourceLineages } from './domain/graph.mjs';
import { ResearchPipeline } from './research/pipeline.mjs';
import { SearchClient } from './research/search.mjs';
import { PiResearchRunner, piConfigFromEnv } from './research/pi-runner.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolve(HERE, '..', 'public');
const MAX_BODY = 120_000;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };

function loadDotEnv(file = join(process.cwd(), '.env')) {
  try {
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/); if (!match || match[1] in process.env) continue;
      const value = match[2].replace(/^("|')(.*)\1$/, '$2').replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (_, name) => process.env[name] ?? ''); process.env[match[1]] = value;
    }
  } catch (error) { if (error?.code !== 'ENOENT') throw error; }
}

function json(res, status, payload) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(payload));
}
function errorJson(res, status, message, code = 'request_error') { json(res, status, { error: { code, message } }); }
function requestUrl(req) { return new URL(req.url ?? '/', 'http://claimlens.local'); }
function isUuid(value) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }

async function bodyJson(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > MAX_BODY) throw Object.assign(new Error('Request body is too large'), { statusCode: 413 });
  }
  if (!body.trim()) return {};
  try { return JSON.parse(body); } catch { throw Object.assign(new Error('Request body must be valid JSON'), { statusCode: 400 }); }
}

function sourceView(source, lineageGroupId) {
  return {
    id: source.id, url: source.url, canonicalUrl: source.canonicalUrl, title: source.title, publisher: source.publisher,
    author: source.author, publishedAt: source.publishedAt, retrievedAt: source.retrievedAt || source.lastRetrievedAt,
    sourceType: source.sourceType, sourceKind: source.sourceKind, quality: source.quality, searchRole: source.searchRole,
    retrievedBy: source.retrievedBy ?? [], retrievalQueries: source.retrievalQueries ?? [], excerpt: source.excerpt || source.snippet || '',
    fetchError: source.fetchError, lineageGroupId,
  };
}
function entityView(entity) {
  if (!entity || typeof entity !== 'object') return entity;
  if (entity.content || entity.excerpt || entity.snippet || entity.url) {
    const lineageGroupId = entity.lineageGroupId;
    return sourceView(entity, lineageGroupId);
  }
  return { ...entity };
}
function graphView(graph) {
  return {
    nodes: (graph?.nodes ?? []).map((node) => ({ id: node.id, type: node.type, label: node.label, entity: entityView(node.entity) })),
    edges: (graph?.edges ?? []).map((edge) => ({ id: edge.id, source: edge.source, target: edge.target, type: edge.type, entity: edge.entity ? { ...edge.entity } : undefined })),
  };
}
function publicReport(report) {
  if (!report) return null;
  return {
    title: report.title, generatedAt: report.generatedAt, executiveConclusion: report.executiveConclusion,
    statusCounts: report.statusCounts, keyFindings: report.keyFindings, limitations: report.limitations,
    whyResearchContinued: report.whyResearchContinued, claims: report.claims, sources: report.sources,
  };
}
function snapshot(state) {
  const lineages = findSourceLineages(state.sources ?? [], state.sourceRelationships ?? []);
  const lineageBySource = new Map(lineages.flatMap((lineage) => lineage.sourceIds.map((id) => [id, lineage.id])));
  const claims = (state.claims ?? []).map((claim) => ({ ...claim }));
  const sources = (state.sources ?? []).map((source) => sourceView(source, lineageBySource.get(source.id)));
  const disputedClaims = claims.filter((claim) => claim.status === 'MIXED' || claim.status === 'CONTRADICTED').length;
  const progress = { ...(state.progress ?? {}), counts: { sources: sources.length, claims: claims.length, disputedClaims, independentSources: lineages.length } };
  const events = (state.events ?? []).map((event, index) => ({ cursor: index, id: event.id, type: event.type, actor: event.actor, payload: event.payload, timestamp: event.timestamp }));
  return {
    session: { ...state.session, demo: Boolean(state.session.metadata?.demo) }, progress, tasks: state.tasks ?? [], claims, sources,
    evidenceEdges: state.evidenceEdges ?? [], sourceRelationships: state.sourceRelationships ?? [], adjudications: state.adjudications ?? [],
    events, graph: graphView(state.graph), report: publicReport(state.report), errors: state.errors ?? [],
  };
}

export async function createClaimLensServer({ dataDir = resolve(process.cwd(), process.env.DATA_DIR || 'data/sessions'), publicDir = PUBLIC_DIR, env = process.env, searchClient, fetchSourceImpl, piRunner, piConfig, pipelineConfig, fixtureMode = false } = {}) {
  const store = await new JsonSessionStore(dataDir).init();
  const demoFile = resolve(dataDir, '..', 'demo-session.json');
  const livePiRunner = piRunner ?? (!fixtureMode && !searchClient ? new PiResearchRunner({ ...piConfigFromEnv(env), ...(piConfig ?? {}) }) : undefined);
  const pipeline = new ResearchPipeline({ store, searchClient: searchClient ?? new SearchClient({ env }), piRunner: livePiRunner, fetchSourceImpl, config: { maxSearchCalls: Number(env.MAX_SEARCH_CALLS) || 8, maxSources: Number(env.MAX_SOURCES) || 28, maxClaims: Number(env.MAX_CLAIMS) || 6, maxFollowUps: Number(env.MAX_FOLLOW_UPS) || 2, maxIterations: Number(env.MAX_RESEARCH_ITERATIONS) || 2, ...pipelineConfig } });

  const server = nodeCreateServer(async (req, res) => {
    try {
      const url = requestUrl(req);
      if (url.pathname === '/api/health' && req.method === 'GET') return json(res, 200, { ok: true, service: 'claimlens', timestamp: new Date().toISOString() });
      if (url.pathname === '/api/sessions' && req.method === 'GET') return json(res, 200, { sessions: await store.list() });
      if (url.pathname === '/api/sessions' && req.method === 'POST') {
        const input = await bodyJson(req);
        if (!input || typeof input !== 'object' || Array.isArray(input)) return errorJson(res, 400, 'Request body must contain a research question.', 'invalid_payload');
        if (typeof input.question !== 'string') return errorJson(res, 400, 'The research question must be text.', 'invalid_question');
        const question = input.question.replace(/\s+/g, ' ').trim();
        if (question.length < 8 || question.length > 2_000) return errorJson(res, 400, 'Enter a research question between 8 and 2,000 characters.', 'invalid_question');
        const state = await store.create(question, { demo: false, runtimeProvider: livePiRunner ? 'pi' : 'fixture' });
        await pipeline.emit(state.session.id, 'session.created', 'system', { message: 'Research session created.' });
        void pipeline.run(state.session.id).catch(() => undefined);
        return json(res, 202, { sessionId: state.session.id, session: snapshot(await store.load(state.session.id)) });
      }
      if (url.pathname === '/api/demo' && req.method === 'GET') {
        const sessions = (await store.list()).filter((session) => session.metadata?.demo && session.status === 'COMPLETE');
        for (const session of sessions) { const candidate = await store.load(session.id); if (candidate?.report && candidate.sources?.length) return json(res, 200, snapshot(candidate)); }
        try {
          const saved = JSON.parse(await readFile(demoFile, 'utf8'));
          if (saved?.session?.metadata?.demo && saved.session.status === 'COMPLETE' && saved.report && saved.sources?.length) return json(res, 200, snapshot(saved));
        } catch { /* A missing or invalid fallback is an honest 404. */ }
        return errorJson(res, 404, 'No previously completed real demo session is available yet.', 'demo_unavailable');
      }
      const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)(?:\/(graph|report|events))?$/);
      if (sessionMatch) {
        const [, id, subroute] = sessionMatch;
        if (!isUuid(id)) return errorJson(res, 400, 'Invalid session id.', 'invalid_session_id');
        const state = await store.load(id);
        if (!state) return errorJson(res, 404, 'Research session not found.', 'session_not_found');
        if (subroute === 'events' && req.method === 'GET') {
          const rawAfter = url.searchParams.get('after') ?? '-1'; const parsedAfter = Number(rawAfter);
          if (!Number.isInteger(parsedAfter) || parsedAfter < -1) return errorJson(res, 400, 'Event cursor must be an integer greater than or equal to -1.', 'invalid_cursor');
          const after = parsedAfter;
          const events = (state.events ?? []).map((event, index) => ({ cursor: index, id: event.id, type: event.type, actor: event.actor, payload: event.payload, timestamp: event.timestamp })).filter((event) => event.cursor > after);
          return json(res, 200, { events, nextCursor: (state.events?.length ?? 0) - 1, done: state.session.status !== 'ACTIVE' });
        }
        if (subroute === 'graph' && req.method === 'GET') return json(res, 200, graphView(state.graph));
        if (subroute === 'report' && req.method === 'GET') return json(res, 200, publicReport(state.report));
        if (!subroute && req.method === 'GET') return json(res, 200, snapshot(state));
      }
      if (req.method !== 'GET' || !url.pathname.startsWith('/')) return errorJson(res, 404, 'Not found.', 'not_found');
      let relative = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
      const file = resolve(publicDir, normalize(relative));
      if (file !== publicDir && !file.startsWith(`${publicDir}/`)) return errorJson(res, 403, 'Forbidden.', 'forbidden');
      try {
        const data = await readFile(file);
        res.statusCode = 200; res.setHeader('content-type', MIME[extname(file)] || 'application/octet-stream'); res.setHeader('cache-control', 'no-cache'); res.end(data);
      } catch (error) {
        if (error?.code === 'ENOENT' && !extname(relative)) {
          const data = await readFile(join(publicDir, 'index.html')); res.statusCode = 200; res.setHeader('content-type', MIME['.html']); res.end(data);
        } else errorJson(res, 404, 'Not found.', 'not_found');
      }
    } catch (error) {
      errorJson(res, error?.statusCode || 500, error?.message || 'Unexpected server error.', 'server_error');
    }
  });
  if (env.RESUME_ACTIVE !== 'false') {
    for (const session of await store.list()) if (session.status === 'ACTIVE') void pipeline.run(session.id).catch(() => undefined);
  }
  return { server, store, pipeline, dataDir, publicDir };
}

export async function startServer(options = {}) {
  loadDotEnv();
  const app = await createClaimLensServer(options);
  const port = Number(options.port ?? process.env.PORT ?? 4173);
  const host = options.host ?? process.env.HOST ?? '127.0.0.1';
  await new Promise((resolve, reject) => {
    const onError = (error) => { app.server.off('listening', onListening); reject(error); };
    const onListening = () => { app.server.off('error', onError); resolve(); };
    app.server.once('error', onError);
    app.server.once('listening', onListening);
    app.server.listen(port, host);
  });
  return { ...app, port, host };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  startServer().then(({ host, port }) => console.log(`ClaimLens listening at http://${host}:${port}`)).catch((error) => { console.error(error); process.exitCode = 1; });
}

import { randomUUID } from 'node:crypto';
import {
  createClaim,
  createResearchTask,
  createSource,
  createSourceRelationship,
  AdjudicationStatus,
  SessionStatus,
  TaskStatus,
  SourceRelationshipType,
} from '../domain/models.mjs';
import { canonicalizeUrl, tokenSetSimilarity } from '../domain/normalization.mjs';
import {
  adjudicateClaims,
  buildGraphPayload,
  buildCitationSafeReport,
  deriveSourceRelationships,
  detectWeakClaims,
  generateFollowUpTaskSpecs,
} from '../domain/graph.mjs';
import { extractClaims, evidenceEdgesFor } from './claims.mjs';
import { SearchClient } from './search.mjs';
import { fetchSource } from './fetch-source.mjs';
import { PiOutputError, validatePiResult } from './pi-schema.mjs';
import { PiResearchRunner } from './pi-runner.mjs';

const DEFAULT_CONFIG = Object.freeze({
  maxSearchCalls: 8,
  maxSources: 28,
  maxClaims: 6,
  maxFollowUps: 2,
  maxIterations: 2,
  searchResultsPerCall: 5,
  fetchConcurrency: 4,
});

const parseLimit = (value, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function uniqueBy(items, key) {
  const seen = new Set();
  return items.filter((item) => { const value = key(item); if (seen.has(value)) return false; seen.add(value); return true; });
}
function nonEmpty(...values) { return values.find((value) => String(value ?? '').trim().length > 0) ?? ''; }

function planQueries(question) {
  const clean = String(question).replace(/\s+/g, ' ').trim();
  return uniqueBy([
    clean,
    `${clean} independent evidence data study`,
    `${clean} limitations criticism analysis`,
  ], (value) => value.toLowerCase()).slice(0, 3);
}

function sourceWithMetadata(raw, result, role) {
  const url = raw.url || result.url;
  const base = createSource({
    id: randomUUID(), url, canonicalUrl: raw.canonicalUrl || url,
    title: raw.title || result.title || url, publisher: raw.publisher || new URL(url).hostname,
    author: raw.author, publishedAt: raw.publishedAt, sourceType: raw.sourceType || 'web', quality: raw.quality ?? 50,
  });
  return {
    ...base,
    ...raw,
    id: base.id,
    url: base.url,
    canonicalUrl: base.canonicalUrl,
    title: base.title,
    publisher: base.publisher,
    sourceType: base.sourceType,
    searchRole: role,
    retrievedBy: [role],
    retrievalQueries: [result.query].filter(Boolean),
    retrievedAt: raw.retrievedAt || new Date().toISOString(),
    excerpt: nonEmpty(raw.excerpt, raw.snippet, result.snippet, raw.content),
    content: nonEmpty(raw.content, raw.excerpt, raw.snippet, result.snippet),
    links: Array.isArray(raw.links) ? raw.links : [],
  };
}

function mergeSource(existing, incoming, role, query) {
  const roles = uniqueBy([...(existing.retrievedBy ?? []), role], (value) => value);
  const queries = uniqueBy([...(existing.retrievalQueries ?? []), query].filter(Boolean), (value) => value.toLowerCase());
  const incomingContent = String(incoming.content || incoming.excerpt || '');
  const existingContent = String(existing.content || existing.excerpt || '');
  return {
    ...existing,
    title: existing.title || incoming.title,
    publisher: existing.publisher || incoming.publisher,
    author: existing.author || incoming.author,
    publishedAt: existing.publishedAt || incoming.publishedAt,
    sourceType: existing.sourceType === 'web' ? incoming.sourceType : existing.sourceType,
    sourceKind: existing.sourceKind || incoming.sourceKind,
    quality: Math.max(existing.quality ?? 0, incoming.quality ?? 0),
    excerpt: incoming.excerpt?.length > (existing.excerpt?.length ?? 0) ? incoming.excerpt : existing.excerpt,
    content: incomingContent.length > existingContent.length ? incoming.content : existing.content,
    links: uniqueBy([...(existing.links ?? []), ...(incoming.links ?? [])], (value) => value).slice(0, 100),
    retrievedBy: roles,
    retrievalQueries: queries,
    searchRole: roles.includes('RESEARCHER') ? 'RESEARCHER' : role,
    lastRetrievedAt: incoming.retrievedAt,
    fetchError: incoming.fetchError,
  };
}

export class ResearchPipeline {
  constructor({ store, searchClient = new SearchClient(), fetchSourceImpl = fetchSource, piRunner, config = {}, onEvent } = {}) {
    if (!store) throw new TypeError('ResearchPipeline requires a session store');
    this.store = store;
    this.searchClient = searchClient;
    this.fetchSource = fetchSourceImpl;
    this.piRunner = piRunner;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.running = new Set();
    this.onEvent = onEvent;
  }

  async emit(sessionId, type, actor, payload = {}) {
    const event = await this.store.appendEvent(sessionId, { type, actor, payload });
    try { await this.onEvent?.(event); } catch { /* event observers must never stop research */ }
    return event;
  }

  async progress(sessionId, phase, percent, message, actor = 'system') {
    await this.store.update(sessionId, (state) => {
      state.progress = { phase, percent: Math.max(0, Math.min(100, percent)), message, actor, updatedAt: new Date().toISOString() };
      state.session.phase = phase;
      if (state.session.status !== SessionStatus.COMPLETE) state.session.status = SessionStatus.ACTIVE;
    });
    await this.emit(sessionId, 'agent.progress', actor, { phase, percent, message });
  }

  async addTask(sessionId, { objective, assignedTo, priority = 50, parentTaskId, constraints = [] }) {
    const task = createResearchTask({ id: randomUUID(), sessionId, objective, assignedTo, priority, parentTaskId, constraints, status: TaskStatus.OPEN });
    await this.store.update(sessionId, (state) => { state.tasks.push(task); });
    return task;
  }

  async taskStatus(sessionId, taskId, status, error) {
    await this.store.update(sessionId, (state) => {
      const task = state.tasks.find((item) => item.id === taskId);
      if (task) {
        task.status = status;
        task.updatedAt = new Date().toISOString();
        if (error) task.error = String(error).slice(0, 500);
      }
    });
  }

  async addSource(sessionId, incoming, result, role) {
    let source;
    await this.store.update(sessionId, (state) => {
      const canonical = canonicalizeUrl(incoming.canonicalUrl || incoming.url);
      const existing = state.sources.find((item) => item.canonicalUrl === canonical);
      if (existing) {
        Object.assign(existing, mergeSource(existing, incoming, role, result.query));
        source = structuredClone(existing);
      } else {
        const created = { ...incoming, canonicalUrl: canonical, searchRole: role, retrievedBy: [role], retrievalQueries: [result.query].filter(Boolean) };
        state.sources.push(created);
        source = structuredClone(created);
      }
      state.progress = { ...(state.progress ?? {}), counts: { sources: state.sources.length, claims: state.claims.length } };
    });
    return source;
  }

  async researchTask(sessionId, task, query, role, budget) {
    if (budget.searchCalls >= this.config.maxSearchCalls) {
      await this.emit(sessionId, 'research.budget.exhausted', 'system', { kind: 'search', max: this.config.maxSearchCalls });
      return { results: [], errors: ['Search budget exhausted'] };
    }
    budget.searchCalls += 1;
    await this.taskStatus(sessionId, task.id, TaskStatus.IN_PROGRESS);
    await this.emit(sessionId, 'research.search.started', role.toLowerCase(), { query, role, taskId: task.id });
    const result = await this.searchClient.search(query, { limit: this.config.searchResultsPerCall, role });
    if (result.errors?.length) await this.emit(sessionId, 'research.search.note', role.toLowerCase(), { query, provider: result.provider, errors: result.errors.slice(0, 3) });
    const results = Array.isArray(result.results) ? result.results.slice(0, this.config.searchResultsPerCall) : [];
    for (const searchResult of results) {
      if (budget.sources >= this.config.maxSources) break;
      if (!/^https?:\/\//i.test(searchResult.url || '')) continue;
      try {
        const raw = await this.fetchSource(searchResult.url, { searchResult, role });
        const incoming = sourceWithMetadata(raw, { ...searchResult, query }, role);
        const source = await this.addSource(sessionId, incoming, { query }, role);
        budget.sources = (await this.store.load(sessionId)).sources.length;
        await this.emit(sessionId, 'research.source.found', role.toLowerCase(), { sourceId: source.id, title: source.title, domain: source.publisher, role, fetchError: source.fetchError });
      } catch (error) {
        await this.emit(sessionId, 'research.source.failed', role.toLowerCase(), { url: searchResult.url, error: error?.message ?? 'Source retrieval failed', role });
      }
    }
    await this.taskStatus(sessionId, task.id, TaskStatus.COMPLETE);
    await this.emit(sessionId, 'research.search.completed', role.toLowerCase(), { query, role, found: results.length });
    return result;
  }

  async refreshEvidence(sessionId) {
    await this.store.update(sessionId, (state) => {
      const claims = state.claims;
      const edges = evidenceEdgesFor(claims, state.sources);
      const byKey = new Map(state.evidenceEdges.map((edge) => [`${edge.claimId}|${edge.sourceId}|${edge.type}`, edge]));
      for (const edge of edges) {
        const key = `${edge.claimId}|${edge.sourceId}|${edge.type}`;
        const previous = byKey.get(key);
        if (!previous || edge.confidence > previous.confidence) byKey.set(key, edge);
      }
      state.evidenceEdges = [...byKey.values()];
      state.graph = buildGraphPayload(state);
    });
  }

  async refreshGenealogy(sessionId) {
    const state = await this.store.load(sessionId);
    const explicitLinks = [];
    const byCanonical = new Map(state.sources.map((source) => [source.canonicalUrl, source.id]));
    for (const source of state.sources) {
      for (const link of source.links ?? []) {
        try {
          const targetId = byCanonical.get(canonicalizeUrl(link));
          if (targetId && targetId !== source.id) {
            explicitLinks.push({ sourceId: source.id, targetSourceId: targetId, type: SourceRelationshipType.CITES, confidence: 94, basis: 'explicit hyperlink found in retrieved page' });
            explicitLinks.push({ sourceId: source.id, targetSourceId: targetId, type: SourceRelationshipType.DERIVED_FROM, confidence: 72, suspected: true, basis: 'suspected dependency inferred from explicit hyperlink' });
          }
        } catch { /* malformed page links are ignored */ }
      }
    }
    const relations = deriveSourceRelationships(state.sources, explicitLinks, { overlapThreshold: 0.78, minimumTokens: 18 });
    await this.store.update(sessionId, (current) => {
      const byKey = new Map(current.sourceRelationships.map((item) => [`${item.sourceId}|${item.targetSourceId}|${item.type}`, item]));
      for (const relation of relations) {
        try {
          const valid = createSourceRelationship({ ...relation });
          const key = `${valid.sourceId}|${valid.targetSourceId}|${valid.type}`;
          if (!byKey.has(key) || valid.confidence > byKey.get(key).confidence) byKey.set(key, valid);
        } catch { /* a stale relationship cannot corrupt the session */ }
      }
      current.sourceRelationships = [...byKey.values()];
      current.graph = buildGraphPayload(current);
    });
    await this.emit(sessionId, 'genealogy.completed', 'independence-auditor', { relationships: relations.length });
  }

  async adjudicate(sessionId) {
    const state = await this.store.load(sessionId);
    const adjudications = adjudicateClaims(state.claims, state.evidenceEdges, state.sources, state.sourceRelationships);
    await this.store.update(sessionId, (current) => {
      current.adjudications = adjudications;
      const byClaim = new Map(adjudications.map((item) => [item.claimId, item]));
      for (const claim of current.claims) {
        const assessment = byClaim.get(claim.id);
        if (assessment) Object.assign(claim, { status: assessment.status, evidenceStrength: assessment.evidenceStrength, factors: assessment.factors, updatedAt: new Date().toISOString() });
      }
      current.graph = buildGraphPayload(current);
    });
    const counts = Object.fromEntries(Object.values(AdjudicationStatus).map((status) => [status, adjudications.filter((item) => item.status === status).length]));
    await this.emit(sessionId, 'adjudication.completed', 'adjudicator', { counts, claims: adjudications.length });
    return adjudications;
  }

  async writeReport(sessionId, followUpReasons = []) {
    const state = await this.store.load(sessionId);
    const base = buildCitationSafeReport(state);
    const statusCounts = Object.fromEntries(Object.values(AdjudicationStatus).map((status) => [status, state.adjudications.filter((item) => item.status === status).length]));
    const overall = statusCounts.MIXED || statusCounts.CONTRADICTED
      ? 'The evidence is not settled. The graph contains meaningful counterevidence or competing interpretations.'
      : statusCounts.SUPPORTED && !statusCounts.UNCERTAIN
        ? 'The available evidence leans supportive, while source quality and independence remain visible for inspection.'
        : 'The available evidence is incomplete. Treat this investigation as a map of what is known and what still needs verification.';
    const claimsWithEvidence = base.claims.filter((claim) => claim.evidence.length);
    const report = {
      ...base,
      generatedAt: new Date().toISOString(),
      executiveConclusion: overall,
      statusCounts,
      keyFindings: claimsWithEvidence.slice(0, 6).map((claim) => ({ claimId: claim.claimId, text: claim.text, status: claim.status, evidenceStrength: claim.evidenceStrength, citations: claim.evidence.map((item) => item.citation) })),
      limitations: [
        state.sources.length ? `${state.sources.length} retrieved source${state.sources.length === 1 ? '' : 's'} were assessed; snippets and page availability can affect directness.` : 'No source was retrieved during this run.',
        state.sourceRelationships.length ? 'Some apparent source diversity was collapsed into suspected or explicit lineages; genealogy is an auditable heuristic, not certainty.' : 'No source genealogy relationship was established.',
        ...followUpReasons,
      ],
      sources: state.sources.map((source) => ({ id: source.id, title: source.title, publisher: source.publisher, url: source.url, publishedAt: source.publishedAt, retrievedAt: source.retrievedAt, searchRole: source.searchRole, quality: source.quality })),
      whyResearchContinued: followUpReasons.length ? followUpReasons.join(' ') : 'The initial evidence set was reviewed by a separate skeptic stage before adjudication.',
    };
    await this.store.update(sessionId, (current) => { current.report = report; current.graph = buildGraphPayload(current); });
    return report;
  }

  async persistPiResult(sessionId, result) {
    const sourceByUrl = new Map();
    const initial = await this.store.load(sessionId);
    for (const sourceResult of result.sources) {
      const publishedAt = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(sourceResult.publishedAt || '') ? sourceResult.publishedAt : undefined;
      const incoming = sourceWithMetadata({ url: sourceResult.url, canonicalUrl: sourceResult.url, title: sourceResult.title, publisher: sourceResult.publisher, author: sourceResult.author, publishedAt, sourceType: sourceResult.sourceType, quality: 50, excerpt: sourceResult.excerpt, content: sourceResult.excerpt, retrievedAt: new Date().toISOString() }, { query: result.queries[0], url: sourceResult.url, title: sourceResult.title }, result.role);
      const source = await this.addSource(sessionId, incoming, { query: result.queries[0] }, result.role);
      sourceByUrl.set(canonicalizeUrl(sourceResult.url), source);
    }
    const claimByText = new Map((initial.claims ?? []).map((claim) => [claim.text.toLowerCase(), claim]));
    for (const claimResult of result.claims) {
      let claim = claimByText.get(claimResult.text.toLowerCase());
      if (!claim) {
        claim = createClaim({ id: randomUUID(), sessionId, text: claimResult.text });
        const assessment = result.assessments.find((item) => item.claimText === claimResult.text);
        if (assessment) claim.piAssessment = { ...assessment, citations: assessment.citations.map((url) => canonicalizeUrl(url)) };
        await this.store.update(sessionId, (state) => { state.claims.push(claim); });
        claimByText.set(claimResult.text.toLowerCase(), claim);
      }
    }
    const addPiEdge = async (edge) => {
      const claim = claimByText.get(edge.claimText.toLowerCase()); const source = sourceByUrl.get(canonicalizeUrl(edge.sourceUrl));
      if (!claim || !source) throw new PiOutputError('Validated Pi evidence references an entity that was not persisted.');
      const input = { id: randomUUID(), claimId: claim.id, sourceId: source.id, type: edge.type, quote: edge.quote, confidence: edge.confidence };
      await this.store.update(sessionId, (state) => { const duplicate = state.evidenceEdges.find((candidate) => candidate.claimId === input.claimId && candidate.sourceId === input.sourceId && candidate.type === input.type); if (!duplicate) state.evidenceEdges.push(input); });
    };
    for (const edge of result.edges) await addPiEdge(edge);
    for (const note of result.contradictions) await addPiEdge({ ...note, type: 'CONTRADICTS', confidence: 88 });
    for (const note of result.qualifications) await addPiEdge({ ...note, type: 'QUALIFIES', confidence: 78 });
    await this.store.update(sessionId, (state) => {
      state.graph = buildGraphPayload(state);
      state.session.runtimeProvider = 'pi';
      state.session.runtimeRoles = [...new Set([...(state.session.runtimeRoles ?? []), result.role])];
    });
    return { sources: sourceByUrl.size, claims: result.claims.length, edges: result.edges.length + result.contradictions.length + result.qualifications.length };
  }

  async runPiRole(sessionId, initial, role, context = {}) {
    const task = await this.addTask(sessionId, { objective: `Pi ${role.toLowerCase()} research pass for: ${initial.session.question}`, assignedTo: role, priority: role === 'SKEPTIC' ? 80 : 70, constraints: ['Use pi-web-access web_search only', 'Return source-grounded structured output without reasoning'] });
    await this.taskStatus(sessionId, task.id, TaskStatus.IN_PROGRESS);
    await this.emit(sessionId, 'research.pi.started', role.toLowerCase(), { provider: 'pi', runtime: 'pi', role, model: this.piRunner.config?.model, taskId: task.id, message: `Pi ${role.toLowerCase()} worker started.` });
    try {
      const packet = await this.piRunner.run({ role, question: initial.session.question, claims: context.claims ?? [], sources: context.sources ?? [], followUpReasons: context.followUpReasons ?? [], maxSearchCalls: context.maxSearchCalls, onProgress: (progress) => { void this.emit(sessionId, 'research.pi.progress', role.toLowerCase(), { provider: 'pi', runtime: 'pi', role, tool: String(progress.kind || '').slice(0, 80), query: String(progress.query ?? '').replace(/\s+/g, ' ').trim().slice(0, 500), queryCount: progress.queryCount, message: String(progress.message || '').slice(0, 300) }); } });
      const result = packet?.result && typeof packet.result === 'object' ? packet.result : packet;
      if (!packet?.observedUrls || !Array.isArray(packet.observedText) || !packet.observedContent) throw new PiOutputError('Pi runner did not provide web-search receipts; refusing to persist ungrounded evidence.', 'pi_receipts_missing');
      const validated = validatePiResult(result, { role, observedUrls: packet.observedUrls, observedText: packet.observedText, observedContent: packet.observedContent });
      const current = await this.store.load(sessionId); const existingUrls = new Set((current.sources ?? []).map((source) => canonicalizeUrl(source.url))); const newSources = new Set(validated.sources.map((source) => canonicalizeUrl(source.url)).filter((url) => !existingUrls.has(url))).size; const existingClaims = new Set((current.claims ?? []).map((claim) => claim.text.toLowerCase())); const newClaims = validated.claims.filter((claim) => !existingClaims.has(claim.text.toLowerCase())).length;
      if (newSources < 0 || (current.sources?.length ?? 0) + newSources > this.config.maxSources || (current.claims?.length ?? 0) + newClaims > this.config.maxClaims) throw new PiOutputError('Pi result exceeded the cumulative source or claim budget.', 'pi_result_budget_exceeded');
      const calls = Number(packet.searchCalls);
      if (!Number.isInteger(calls) || calls < 1 || calls > (context.maxSearchCalls ?? this.config.maxSearchCalls)) throw new PiOutputError('Pi result did not provide a valid bounded web-search call count.', 'pi_search_budget_invalid');
      if (context.budget) context.budget.searchCalls += calls;
      const counts = await this.persistPiResult(sessionId, validated);
      await this.taskStatus(sessionId, task.id, TaskStatus.COMPLETE);
      await this.emit(sessionId, 'research.pi.completed', role.toLowerCase(), { provider: 'pi', runtime: 'pi', role, sourceCount: counts.sources, claimCount: counts.claims, edgeCount: counts.edges, searchQueryCount: validated.queries.length, searchCalls: packet?.searchCalls ?? undefined });
      return validated;
    } catch (error) {
      await this.taskStatus(sessionId, task.id, TaskStatus.CANCELLED, error?.message ?? 'Pi worker failed');
      throw error;
    }
  }

  async runPiResearch(sessionId, initial) {
    const budget = { searchCalls: 0 };
    await this.store.update(sessionId, (state) => { state.session.runtimeProvider = 'pi'; state.session.runtimeProjectDir = this.piRunner.config?.projectDir; state.session.runtimeModel = this.piRunner.config?.model; });
    await this.progress(sessionId, 'PLANNING', 5, 'Pi is planning independent research paths.', 'planner');
    await this.emit(sessionId, 'research.runtime.selected', 'system', { provider: 'pi', runtime: 'pi', projectDir: this.piRunner.config?.projectDir, message: 'Research is delegated to the installed Pi runtime.' });
    await this.progress(sessionId, 'RESEARCHING', 18, 'Pi researcher is searching with pi-web-search.', 'researcher');
    const researcher = await this.runPiRole(sessionId, initial, 'RESEARCHER', { budget, maxSearchCalls: this.config.maxSearchCalls });
    await this.progress(sessionId, 'EXTRACTING', 42, 'Pi researcher returned source-grounded claims.', 'researcher');
    let state = await this.store.load(sessionId);
    await this.progress(sessionId, 'SKEPTIC', 52, 'Pi skeptic is searching for contradictions and limitations.', 'skeptic');
    if (budget.searchCalls >= this.config.maxSearchCalls) throw new PiOutputError('Pi web-search budget was exhausted before the skeptic pass.', 'pi_search_budget_exhausted');
    const skeptic = await this.runPiRole(sessionId, initial, 'SKEPTIC', { claims: state.claims, sources: state.sources, budget, maxSearchCalls: this.config.maxSearchCalls - budget.searchCalls });
    await this.emit(sessionId, 'skeptic.completed', 'skeptic', { provider: 'pi', runtime: 'pi', role: skeptic.role, searches: skeptic.queries.length, newSourceCount: (await this.store.load(sessionId)).sources.length - state.sources.length });
    await this.progress(sessionId, 'GENEALOGY', 68, 'Tracing source lineage and independent origins.', 'independence-auditor');
    await this.refreshGenealogy(sessionId);
    await this.progress(sessionId, 'ADJUDICATING', 76, 'Adjudicating Pi claims using their retrieved evidence.', 'adjudicator');
    let adjudications = await this.adjudicate(sessionId);
    state = await this.store.load(sessionId);
    const weak = detectWeakClaims(state.claims, adjudications, { minimumStrength: 78 });
    const followUps = generateFollowUpTaskSpecs(weak, { maxTasks: this.config.maxFollowUps, sessionId });
    let followUpReasons = [];
    if (followUps.length && this.config.maxIterations > 1) {
      followUpReasons = followUps.map((task) => `Pi found weak evidence for “${(state.claims.find((claim) => claim.id === task.claimId)?.text ?? task.objective).slice(0, 160)}” and ran a bounded independent follow-up.`);
      await this.progress(sessionId, 'FOLLOW_UP', 82, 'Pi is running one bounded follow-up for weak claims.', 'weakness-detector');
      await this.emit(sessionId, 'followup.triggered', 'weakness-detector', { provider: 'pi', runtime: 'pi', count: followUps.length, reasons: followUpReasons });
      if (budget.searchCalls >= this.config.maxSearchCalls) throw new PiOutputError('Pi web-search budget was exhausted before the follow-up pass.', 'pi_search_budget_exhausted');
      await this.runPiRole(sessionId, initial, 'FOLLOW_UP', { claims: state.claims, sources: state.sources, followUpReasons, budget, maxSearchCalls: this.config.maxSearchCalls - budget.searchCalls });
      await this.refreshGenealogy(sessionId);
      adjudications = await this.adjudicate(sessionId);
    } else await this.progress(sessionId, 'FOLLOW_UP', 82, 'No bounded Pi follow-up was needed.', 'weakness-detector');
    await this.progress(sessionId, 'REPORTING', 92, 'Writing a citation-backed report from Pi evidence.', 'reporter');
    await this.writeReport(sessionId, followUpReasons);
    await this.store.update(sessionId, (state) => { state.progress = { phase: 'DONE', percent: 100, message: 'Pi investigation complete. Inspect the graph to audit each claim.', actor: 'system', updatedAt: new Date().toISOString() }; state.session.phase = 'DONE'; state.session.status = SessionStatus.COMPLETE; state.session.completedAt = new Date().toISOString(); });
    await this.emit(sessionId, 'session.completed', 'system', { provider: 'pi', runtime: 'pi', sources: (await this.store.load(sessionId)).sources.length, claims: adjudications.length });
    return { researcher, skeptic, adjudications };
  }

  async run(sessionId) {
    if (this.running.has(sessionId)) return;
    this.running.add(sessionId);
    const budget = { searchCalls: 0, sources: 0 };
    let followUpReasons = [];
    try {
      const initial = await this.store.load(sessionId);
      if (!initial) throw new Error('Session not found');
      if (this.piRunner) { await this.runPiResearch(sessionId, initial); return; }
      const question = initial.session.question;
      await this.progress(sessionId, 'PLANNING', 5, 'Planning independent research paths.', 'planner');
      const plans = planQueries(question);
      for (const query of plans) await this.addTask(sessionId, { objective: `Researcher search: ${query}`, assignedTo: 'RESEARCHER', priority: 60, constraints: ['Prefer direct, recent, and primary evidence'] });
      await this.emit(sessionId, 'planner.completed', 'planner', { paths: plans.length });

      await this.progress(sessionId, 'RESEARCHING', 15, 'Researcher is finding the strongest available evidence.', 'researcher');
      let state = await this.store.load(sessionId);
      const researcherTasks = state.tasks.filter((task) => task.assignedTo === 'RESEARCHER');
      for (let index = 0; index < researcherTasks.length; index++) {
        if (budget.searchCalls >= this.config.maxSearchCalls) break;
        await this.researchTask(sessionId, researcherTasks[index], plans[index], 'RESEARCHER', budget);
        await this.progress(sessionId, 'RESEARCHING', 15 + Math.round(((index + 1) / researcherTasks.length) * 20), `Researcher found ${budget.sources} source${budget.sources === 1 ? '' : 's'}.`, 'researcher');
      }

      await this.progress(sessionId, 'EXTRACTING', 40, 'Extracting atomic claims and linking them to source passages.', 'claim-extractor');
      state = await this.store.load(sessionId);
      const claims = extractClaims(question, state.sources, { sessionId, maxClaims: this.config.maxClaims });
      await this.store.update(sessionId, (current) => {
        const existing = new Set(current.claims.map((claim) => claim.text.toLowerCase()));
        for (const claim of claims) if (!existing.has(claim.text.toLowerCase())) current.claims.push(claim);
      });
      await this.refreshEvidence(sessionId);
      await this.emit(sessionId, 'claims.extracted', 'claim-extractor', { count: claims.length });

      await this.progress(sessionId, 'SKEPTIC', 50, 'Skeptic is searching for contradictions, caveats, and missing primary evidence.', 'skeptic');
      state = await this.store.load(sessionId);
      const skepticQueries = uniqueBy([
        `${question} counterevidence criticism limitations`,
        ...state.claims.slice(0, 3).map((claim) => `${claim.text} contrary evidence independent data`),
      ], (value) => value.toLowerCase()).slice(0, 3);
      const skepticTasks = [];
      for (const query of skepticQueries) skepticTasks.push(await this.addTask(sessionId, { objective: `Skeptic search: ${query}`, assignedTo: 'SKEPTIC', priority: 80, constraints: ['Look for credible contradiction, qualification, or independent evidence'] }));
      for (let index = 0; index < skepticTasks.length; index++) {
        if (budget.searchCalls >= this.config.maxSearchCalls) break;
        await this.researchTask(sessionId, skepticTasks[index], skepticQueries[index], 'SKEPTIC', budget);
      }
      await this.refreshEvidence(sessionId);
      await this.emit(sessionId, 'skeptic.completed', 'skeptic', { searches: Math.min(skepticTasks.length, budget.searchCalls), newSourceCount: (await this.store.load(sessionId)).sources.filter((source) => (source.retrievedBy ?? []).includes('SKEPTIC')).length });

      await this.progress(sessionId, 'GENEALOGY', 68, 'Tracing shared origins so repeated citations do not count as independent proof.', 'independence-auditor');
      await this.refreshGenealogy(sessionId);
      await this.progress(sessionId, 'ADJUDICATING', 76, 'Adjudicating each claim using quality, directness, recency, and independent lineages.', 'adjudicator');
      let adjudications = await this.adjudicate(sessionId);
      state = await this.store.load(sessionId);
      const weak = detectWeakClaims(state.claims, adjudications, { minimumStrength: 78 });
      const followUps = generateFollowUpTaskSpecs(weak, { maxTasks: this.config.maxFollowUps, sessionId });
      if (followUps.length && budget.searchCalls < this.config.maxSearchCalls && this.config.maxIterations > 1) {
        followUpReasons = followUps.map((task) => {
          const claimText = state.claims.find((claim) => claim.id === task.claimId)?.text ?? task.objective.replace(/^Find an independent source that directly tests this claim: /, '');
          return `Initial evidence was weak for “${claimText.slice(0, 160)}”; ClaimLens searched for an independent primary source.`;
        });
        await this.progress(sessionId, 'FOLLOW_UP', 82, 'Weak points found. Launching targeted independent follow-up research.', 'weakness-detector');
        await this.emit(sessionId, 'followup.triggered', 'weakness-detector', { count: followUps.length, reasons: followUpReasons });
        for (const spec of followUps) {
          const task = await this.addTask(sessionId, { objective: spec.objective, assignedTo: 'FOLLOW_UP', priority: spec.priority ?? 75, constraints: spec.constraints, parentTaskId: state.tasks[0]?.id });
          const query = `${state.claims.find((claim) => claim.id === spec.claimId)?.text ?? spec.objective} independent primary data`;
          if (budget.searchCalls >= this.config.maxSearchCalls) break;
          await this.researchTask(sessionId, task, query, 'FOLLOW_UP', budget);
        }
        await this.refreshEvidence(sessionId);
        await this.refreshGenealogy(sessionId);
        adjudications = await this.adjudicate(sessionId);
      } else {
        await this.progress(sessionId, 'FOLLOW_UP', 82, 'No additional targeted search was needed within the research budget.', 'weakness-detector');
      }

      await this.progress(sessionId, 'REPORTING', 92, 'Writing a cited report from the evidence graph.', 'reporter');
      await this.writeReport(sessionId, followUpReasons);
      await this.store.update(sessionId, (current) => {
        current.progress = { phase: 'DONE', percent: 100, message: 'Investigation complete. Inspect the graph to see why each claim earned its status.', actor: 'system', updatedAt: new Date().toISOString() };
        current.session.phase = 'DONE';
        current.session.status = SessionStatus.COMPLETE;
        current.session.completedAt = new Date().toISOString();
      });
      await this.emit(sessionId, 'session.completed', 'system', { sources: (await this.store.load(sessionId)).sources.length, claims: adjudications.length, searchCalls: budget.searchCalls });
    } catch (error) {
      const message = error?.message ?? 'Research pipeline failed';
      await this.store.update(sessionId, (state) => {
        state.errors.push({ message, timestamp: new Date().toISOString() });
        state.session.status = SessionStatus.FAILED;
        state.session.error = message.slice(0, 500);
        state.session.failedAt = new Date().toISOString();
        state.progress = { ...(state.progress ?? {}), phase: 'FAILED', message: 'Research failed. Partial evidence remains available.', percent: state.progress?.percent ?? 0 };
      }).catch(() => undefined);
      await this.emit(sessionId, 'session.failed', 'system', { message }).catch(() => undefined);
    } finally {
      this.running.delete(sessionId);
    }
  }
}

async function sourceIndexAfterAdd(sessionId, source) {
  // The source count is persisted in the snapshot; this helper avoids sharing mutable state across fetches.
  return source ? 1 : 0;
}

export { DEFAULT_CONFIG, planQueries, sourceWithMetadata, mergeSource };

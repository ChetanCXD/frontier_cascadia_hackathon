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
    author: raw.author, publishedAt: raw.publishedAt, sourceType: raw.sourceType || 'web', quality: raw.quality,
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
    excerpt: raw.excerpt || raw.snippet || result.snippet || '',
    content: raw.content || raw.excerpt || raw.snippet || result.snippet || '',
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
  constructor({ store, searchClient = new SearchClient(), fetchSourceImpl = fetchSource, config = {}, onEvent } = {}) {
    if (!store) throw new TypeError('ResearchPipeline requires a session store');
    this.store = store;
    this.searchClient = searchClient;
    this.fetchSource = fetchSourceImpl;
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
          if (targetId && targetId !== source.id) explicitLinks.push({ sourceId: source.id, targetSourceId: targetId, type: SourceRelationshipType.CITES, confidence: 94 });
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

  async run(sessionId) {
    if (this.running.has(sessionId)) return;
    this.running.add(sessionId);
    const budget = { searchCalls: 0, sources: 0 };
    let followUpReasons = [];
    try {
      const initial = await this.store.load(sessionId);
      if (!initial) throw new Error('Session not found');
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
      await this.store.update(sessionId, (state) => {
        state.errors.push({ message: error?.message ?? 'Research pipeline failed', timestamp: new Date().toISOString() });
        state.session.status = SessionStatus.PAUSED;
        state.progress = { ...(state.progress ?? {}), phase: 'PAUSED', message: 'Research paused after an error. Partial evidence remains available.', percent: state.progress?.percent ?? 0 };
      }).catch(() => undefined);
      await this.emit(sessionId, 'session.paused', 'system', { message: error?.message ?? 'Research pipeline failed' }).catch(() => undefined);
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

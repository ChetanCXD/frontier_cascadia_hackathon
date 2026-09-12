import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { JsonSessionStore } from '../src/domain/store.mjs';
import { ResearchPipeline } from '../src/research/pipeline.mjs';
import { SearchClient } from '../src/research/search.mjs';

const cases = [
  { name: 'conflicting', question: 'Does intermittent fasting improve weight loss compared with calorie restriction?' },
  { name: 'repeated-lineage', question: 'What is the current federal funds rate?' },
  { name: 'consensus', question: 'Does smoking cause lung cancer?' },
  { name: 'insufficient', question: 'Will a newly created private company double its stock price next Tuesday?' },
];
const store = await new JsonSessionStore(process.env.DATA_DIR || 'data/sessions').init();
const searchClient = new SearchClient({ env: { ...process.env, SEARCH_PROVIDER: process.env.SEARCH_PROVIDER || 'duckduckgo' }, timeoutMs: 9_000 });
const summary = [];
for (const item of cases) {
  const created = await store.create(item.question, { evaluationCase: item.name });
  const pipeline = new ResearchPipeline({ store, searchClient, config: { maxSearchCalls: 8, maxSources: 12, maxClaims: 4, maxFollowUps: 1, maxIterations: 2, searchResultsPerCall: 3 } });
  await pipeline.run(created.session.id);
  const state = await store.load(created.session.id);
  const edgeTypes = Object.fromEntries([...new Set(state.evidenceEdges.map((edge) => edge.type))].map((type) => [type, state.evidenceEdges.filter((edge) => edge.type === type).length]));
  const statusCounts = Object.fromEntries([...new Set(state.adjudications.map((item) => item.status))].map((status) => [status, state.adjudications.filter((item) => item.status === status).length]));
  const skepticSearches = state.events.filter((event) => event.actor === 'skeptic' && event.type === 'research.search.started').length;
  const followUps = state.events.filter((event) => event.type === 'followup.triggered').length;
  const citationIds = new Set(state.sources.map((source) => source.id));
  const relationshipTypes = [...new Set(state.sourceRelationships.map((relation) => relation.type))];
  const relationshipsValid = state.sourceRelationships.every((relation) => citationIds.has(relation.sourceId) && citationIds.has(relation.targetSourceId) && Number.isFinite(relation.confidence));
  const sourcesHaveReceipts = state.sources.every((source) => /^https?:\/\//i.test(source.url || '') && (String(source.excerpt || source.content || '').trim().length > 20 || Boolean(source.fetchError)));
  const edgesHaveReceipts = state.evidenceEdges.every((edge) => citationIds.has(edge.sourceId) && String(edge.quote || '').trim().length > 20);
  const citationsValid = state.report?.claims?.every((claim) => claim.evidence.every((evidence) => citationIds.has(evidence.citation.sourceId) && /^https?:\/\//i.test(evidence.citation.url || ''))) ?? false;
  const followUpCompleted = state.tasks.some((task) => task.assignedTo === 'FOLLOW_UP' && task.status === 'COMPLETE');
  const terminated = state.events.some((event) => event.type === 'session.completed') && Boolean(state.session.completedAt);
  if (state.session.status !== 'COMPLETE' || !terminated || !state.report || !state.sources.length || !state.claims.length || skepticSearches < 1 || followUps < 1 || !followUpCompleted || !sourcesHaveReceipts || !edgesHaveReceipts || !relationshipsValid || !citationsValid) throw new Error(`Live evaluation failed its base assertions for ${item.name}`);
  if (item.name === 'conflicting' && (!(edgeTypes.SUPPORTS > 0) || !(edgeTypes.CONTRADICTS > 0) || !statusCounts.MIXED)) throw new Error('Conflicting case did not surface both support and contradiction');
  if (item.name === 'repeated-lineage' && !relationshipTypes.includes('POSSIBLY_SAME_ORIGIN')) throw new Error('Repeated-lineage case did not surface a suspected shared-origin relationship');
  if (item.name === 'consensus' && !(edgeTypes.SUPPORTS > 0)) throw new Error('Consensus case did not surface supporting evidence');
  if (item.name === 'insufficient' && !statusCounts.UNCERTAIN) throw new Error('Insufficient-evidence case did not retain an UNCERTAIN central proposition');
  const artifactDir = process.env.EVALUATION_DIR || 'data/evaluations';
  await mkdir(artifactDir, { recursive: true });
  const artifact = {
    artifactVersion: 1, realRun: true, provider: 'DuckDuckGo HTML', evaluatedAt: new Date().toISOString(),
    case: item, session: state.session, progress: state.progress, tasks: state.tasks,
    claims: state.claims, sources: state.sources.map(({ content: _content, ...source }) => source),
    evidenceEdges: state.evidenceEdges, sourceRelationships: state.sourceRelationships,
    adjudications: state.adjudications, events: state.events, report: state.report,
  };
  await writeFile(join(artifactDir, `${item.name}.json`), `${JSON.stringify(artifact, null, 2)}\n`);
  summary.push({ name: item.name, question: item.question, sessionId: created.session.id, artifact: join(artifactDir, `${item.name}.json`), status: state.session.status, terminated, sources: state.sources.length, claims: state.claims.length, edgeTypes, sourceRelationships: state.sourceRelationships.length, relationshipTypes, statusCounts, skepticSearches, followUps, report: Boolean(state.report), assertions: { citationsValid, sourcesHaveReceipts, edgesHaveReceipts, relationshipsValid, followUpCompleted, terminated, skepticSearches: skepticSearches >= 1, followUps: followUps >= 1 } });
  console.log(JSON.stringify(summary.at(-1)));
}
await writeFile(process.env.EVALUATION_OUTPUT || 'data/evaluation-summary.json', `${JSON.stringify({ generatedAt: new Date().toISOString(), cases: summary }, null, 2)}\n`);

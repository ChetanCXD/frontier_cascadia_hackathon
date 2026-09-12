import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { JsonSessionStore } from '../src/domain/store.mjs';
import { ResearchPipeline } from '../src/research/pipeline.mjs';
import { SearchClient } from '../src/research/search.mjs';

const cases = [
  { name: 'conflicting', question: 'Are electric vehicles better for the environment than gasoline cars over their full lifecycle?' },
  { name: 'repeated-lineage', question: 'Will solid-state batteries reach mass-market electric vehicles before 2030?' },
  { name: 'consensus', question: 'Does smoking cause lung cancer?' },
  { name: 'insufficient', question: 'Will a newly created private company double its stock price next Tuesday?' },
];
const store = await new JsonSessionStore(process.env.DATA_DIR || 'data/sessions').init();
const searchClient = new SearchClient({ env: { ...process.env, SEARCH_PROVIDER: process.env.SEARCH_PROVIDER || 'duckduckgo' }, timeoutMs: 9_000 });
const summary = [];
for (const item of cases) {
  const created = await store.create(item.question, { evaluationCase: item.name });
  const pipeline = new ResearchPipeline({ store, searchClient, config: { maxSearchCalls: 5, maxSources: 10, maxClaims: 4, maxFollowUps: 1, maxIterations: 2, searchResultsPerCall: 3 } });
  await pipeline.run(created.session.id);
  const state = await store.load(created.session.id);
  const edgeTypes = Object.fromEntries([...new Set(state.evidenceEdges.map((edge) => edge.type))].map((type) => [type, state.evidenceEdges.filter((edge) => edge.type === type).length]));
  const statusCounts = Object.fromEntries([...new Set(state.adjudications.map((item) => item.status))].map((status) => [status, state.adjudications.filter((item) => item.status === status).length]));
  const skepticSearches = state.events.filter((event) => event.actor === 'skeptic' && event.type === 'research.search.started').length;
  const citationIds = new Set(state.sources.map((source) => source.id));
  const citationsValid = state.report?.claims?.every((claim) => claim.evidence.every((evidence) => citationIds.has(evidence.citation.sourceId))) ?? false;
  if (state.session.status !== 'COMPLETE' || !state.report || !state.sources.length || !state.claims.length || skepticSearches < 1 || !citationsValid) throw new Error(`Live evaluation failed its base assertions for ${item.name}`);
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
  summary.push({ name: item.name, question: item.question, sessionId: created.session.id, artifact: join(artifactDir, `${item.name}.json`), status: state.session.status, sources: state.sources.length, claims: state.claims.length, edgeTypes, sourceRelationships: state.sourceRelationships.length, relationshipTypes: [...new Set(state.sourceRelationships.map((relation) => relation.type))], statusCounts, skepticSearches, followUps: state.events.filter((event) => event.type === 'followup.triggered').length, report: Boolean(state.report), assertions: { citationsValid, skepticSearches: skepticSearches >= 1 } });
  console.log(JSON.stringify(summary.at(-1)));
}
await writeFile(process.env.EVALUATION_OUTPUT || 'data/evaluation-summary.json', `${JSON.stringify({ generatedAt: new Date().toISOString(), cases: summary }, null, 2)}\n`);

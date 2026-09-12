import { writeFile } from 'node:fs/promises';
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
  summary.push({ name: item.name, question: item.question, sessionId: created.session.id, status: state.session.status, sources: state.sources.length, claims: state.claims.length, edgeTypes, sourceRelationships: state.sourceRelationships.length, relationshipTypes: [...new Set(state.sourceRelationships.map((relation) => relation.type))], statusCounts, skepticSearches: state.events.filter((event) => event.actor === 'skeptic' && event.type === 'research.search.started').length, followUps: state.events.filter((event) => event.type === 'followup.triggered').length, report: Boolean(state.report) });
  console.log(JSON.stringify(summary.at(-1)));
}
await writeFile(process.env.EVALUATION_OUTPUT || 'data/evaluation-summary.json', `${JSON.stringify({ generatedAt: new Date().toISOString(), cases: summary }, null, 2)}\n`);

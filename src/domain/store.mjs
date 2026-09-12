import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  createAgentEvent,
  createResearchSession,
  createResearchTask,
  createClaim,
  createSource,
  createEvidenceEdge,
  createSourceRelationship,
  createAdjudication,
} from './models.mjs';
import { canonicalizeUrl } from './normalization.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const clone = (value) => structuredClone(value);
const safeId = (id) => {
  if (typeof id !== 'string' || !UUID.test(id)) throw new TypeError('session id must be a UUID');
  return id;
};

export function createEmptySession(question, metadata = {}) {
  const text = String(question ?? '').trim();
  const session = createResearchSession({
    id: randomUUID(),
    title: `Investigation: ${text.slice(0, 96)}`,
    question: text,
    metadata,
  });
  return {
    session,
    tasks: [],
    claims: [],
    sources: [],
    evidenceEdges: [],
    sourceRelationships: [],
    adjudications: [],
    events: [],
    report: null,
    graph: { nodes: [], edges: [] },
    errors: [],
  };
}

export class JsonSessionStore {
  constructor(root) {
    this.root = root;
    this.locks = new Map();
  }

  async init() {
    await mkdir(this.root, { recursive: true });
    return this;
  }

  fileFor(id) { return join(this.root, `session-${safeId(id)}.json`); }

  async load(id) {
    const file = this.fileFor(id);
    try {
      return JSON.parse(await readFile(file, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }

  async save(state) {
    const id = safeId(state?.session?.id);
    const file = this.fileFor(id);
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, file);
    return state;
  }

  async create(question, metadata = {}) {
    const state = createEmptySession(question, metadata);
    await this.save(state);
    return clone(state);
  }

  async update(id, mutator) {
    safeId(id);
    const previous = this.locks.get(id) ?? Promise.resolve();
    const operation = previous.then(async () => {
      const state = await this.load(id);
      if (!state) throw new Error(`Session ${id} not found`);
      const result = await mutator(state);
      state.session.updatedAt = new Date().toISOString();
      await this.save(state);
      return clone(result ?? state);
    });
    const lock = operation.catch(() => undefined);
    this.locks.set(id, lock);
    try { return await operation; } finally {
      if (this.locks.get(id) === lock) this.locks.delete(id);
    }
  }

  async appendEvent(id, input) {
    const event = createAgentEvent({ ...input, sessionId: id });
    await this.update(id, (state) => { state.events.push(event); });
    return event;
  }

  async list() {
    await this.init();
    const names = (await readdir(this.root)).filter((name) => /^session-[0-9a-f-]+\.json$/i.test(name));
    const sessions = [];
    for (const name of names) {
      try {
        const state = JSON.parse(await readFile(join(this.root, name), 'utf8'));
        if (state?.session) sessions.push(state.session);
      } catch { /* A corrupt session should not prevent the history list loading. */ }
    }
    return sessions.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  async addTask(id, input) {
    const task = createResearchTask({ ...input, sessionId: id });
    await this.update(id, (state) => { state.tasks.push(task); });
    return task;
  }

  async addClaim(id, input) {
    const claim = createClaim({ ...input, sessionId: id });
    await this.update(id, (state) => { state.claims.push(claim); });
    return claim;
  }

  async upsertSource(id, input) {
    const source = createSource(input);
    let result = source;
    await this.update(id, (state) => {
      const key = source.canonicalUrl;
      const existing = state.sources.find((candidate) => candidate.canonicalUrl === key);
      if (existing) {
        Object.assign(existing, Object.fromEntries(Object.entries(source).filter(([, value]) => value !== undefined)));
        result = existing;
      } else state.sources.push(source);
    });
    return clone(result);
  }

  async addEvidenceEdge(id, input) {
    const edge = createEvidenceEdge(input);
    await this.update(id, (state) => {
      const existing = state.evidenceEdges.find((candidate) => candidate.claimId === edge.claimId && candidate.sourceId === edge.sourceId && candidate.type === edge.type);
      if (existing) Object.assign(existing, edge);
      else state.evidenceEdges.push(edge);
    });
    return edge;
  }

  async addSourceRelationship(id, input) {
    const relationship = createSourceRelationship(input);
    await this.update(id, (state) => {
      const existing = state.sourceRelationships.find((candidate) => candidate.sourceId === relationship.sourceId && candidate.targetSourceId === relationship.targetSourceId && candidate.type === relationship.type);
      if (existing) Object.assign(existing, relationship);
      else state.sourceRelationships.push(relationship);
    });
    return relationship;
  }

  async setAdjudications(id, adjudications) {
    const valid = adjudications.map((item) => createAdjudication(item));
    await this.update(id, (state) => { state.adjudications = valid; });
    return valid;
  }

  async findSourceByUrl(id, url) {
    const state = await this.load(id);
    if (!state) return null;
    const canonical = canonicalizeUrl(url);
    return clone(state.sources.find((source) => source.canonicalUrl === canonical) ?? null);
  }
}

export function normalizeSessionState(state) {
  return clone(state);
}

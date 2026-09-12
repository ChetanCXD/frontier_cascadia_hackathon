import { randomUUID } from 'node:crypto';
import { canonicalizeUrl } from './normalization.mjs';

export const SUPPORTS = 'SUPPORTS';
export const CONTRADICTS = 'CONTRADICTS';
export const QUALIFIES = 'QUALIFIES';
export const DERIVED_FROM = 'DERIVED_FROM';
export const CITES = 'CITES';
export const POSSIBLY_SAME_ORIGIN = 'POSSIBLY_SAME_ORIGIN';
export const SUPPORTED = 'SUPPORTED';
export const CONTRADICTED = 'CONTRADICTED';
export const MIXED = 'MIXED';
export const UNCERTAIN = 'UNCERTAIN';
export const EvidenceType = Object.freeze({ SUPPORTS, CONTRADICTS, QUALIFIES });
export const SourceRelationshipType = Object.freeze({ DERIVED_FROM, CITES, POSSIBLY_SAME_ORIGIN });
export const AdjudicationStatus = Object.freeze({ SUPPORTED, CONTRADICTED, MIXED, UNCERTAIN });
export const SessionStatus = Object.freeze({ ACTIVE: 'ACTIVE', COMPLETE: 'COMPLETE', PARTIAL: 'PARTIAL', PAUSED: 'PAUSED', FAILED: 'FAILED' });
export const TaskStatus = Object.freeze({ OPEN: 'OPEN', IN_PROGRESS: 'IN_PROGRESS', COMPLETE: 'COMPLETE', CANCELLED: 'CANCELLED' });

export const MODEL_SCHEMAS = Object.freeze({
  ResearchSession: ['id', 'title', 'question', 'status', 'createdAt', 'updatedAt', 'metadata'],
  ResearchTask: ['id', 'sessionId', 'objective', 'status', 'priority', 'assignedTo', 'parentTaskId', 'constraints', 'createdAt', 'updatedAt'],
  Claim: ['id', 'sessionId', 'text', 'status', 'createdAt', 'updatedAt'],
  Source: ['id', 'url', 'canonicalUrl', 'title', 'publisher', 'author', 'publishedAt', 'sourceType', 'quality', 'createdAt'],
  EvidenceEdge: ['id', 'claimId', 'sourceId', 'type', 'quote', 'confidence', 'createdAt'],
  SourceRelationship: ['id', 'sourceId', 'targetSourceId', 'type', 'confidence', 'createdAt'],
  Adjudication: ['id', 'claimId', 'status', 'evidenceStrength', 'factors', 'supportingSourceIds', 'contradictingSourceIds', 'qualifyingSourceIds', 'createdAt'],
  AgentEvent: ['id', 'sessionId', 'type', 'actor', 'payload', 'timestamp']
});

const MAX = Object.freeze({ short: 256, text: 12000, url: 4096, quote: 6000, json: 20000 });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/;
const forbidden = new Set(['chainOfThought', 'chain_of_thought', 'thoughts', 'reasoning', 'internalReasoning']);

function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  for (const key of Object.keys(value)) if (forbidden.has(key)) throw new TypeError(`${name}.${key} is not permitted`);
  return value;
}
function str(value, field, max = MAX.short, { optional = false } = {}) {
  if (value === undefined && optional) return undefined;
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) throw new TypeError(`${field} must be a non-empty string of at most ${max} characters`);
  return value.trim();
}
function id(value, field = 'id') {
  const v = value === undefined ? randomUUID() : value;
  if (typeof v !== 'string' || !UUID.test(v)) throw new TypeError(`${field} must be a UUID`);
  return v;
}
function time(value, field, optional = false) {
  if (value === undefined && optional) return undefined;
  const v = value === undefined ? new Date().toISOString() : value;
  if (typeof v !== 'string' || !ISO.test(v) || Number.isNaN(Date.parse(v))) throw new TypeError(`${field} must be an ISO UTC timestamp`);
  return v;
}
function oneOf(value, field, choices) { if (!Object.values(choices).includes(value)) throw new TypeError(`${field} has an invalid value`); return value; }
function list(value, field, mapper = x => x, max = 100) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max) throw new TypeError(`${field} must be an array of at most ${max} items`);
  return value.map(mapper);
}
function plainJson(value, field, max = MAX.json) {
  if (value === undefined) return {};
  const inspect = current => {
    if (!current || typeof current !== 'object') return;
    for (const key of Object.keys(current)) {
      if (forbidden.has(key)) throw new TypeError(`${field}.${key} is not permitted`);
      inspect(current[key]);
    }
  };
  inspect(value);
  let encoded;
  try { encoded = JSON.stringify(value); } catch { throw new TypeError(`${field} must be JSON-compatible`); }
  if (encoded.length > max) throw new TypeError(`${field} is too large`);
  return structuredClone(value);
}
function number(value, field, min = 0, max = 100) { if (!Number.isFinite(value) || value < min || value > max) throw new TypeError(`${field} must be between ${min} and ${max}`); return value; }
function url(value, field = 'url') { const v = str(value, field, MAX.url); try { const u = new URL(v); if (!['http:', 'https:'].includes(u.protocol)) throw new Error(); } catch { throw new TypeError(`${field} must be an HTTP(S) URL`); } return v; }
function base(value, field, createdField = 'createdAt') { return { id: id(value.id), [createdField]: time(value[createdField], createdField) }; }

export function createResearchSession(input = {}) {
  const v = object(input, 'ResearchSession');
  const b = base(v, 'ResearchSession');
  return { ...b, title: str(v.title, 'title'), question: str(v.question, 'question', MAX.text), status: oneOf(v.status ?? SessionStatus.ACTIVE, 'status', SessionStatus), createdAt: b.createdAt, updatedAt: time(v.updatedAt, 'updatedAt'), metadata: plainJson(v.metadata, 'metadata') };
}
export function createResearchTask(input = {}) {
  const v = object(input, 'ResearchTask');
  const b = base(v, 'ResearchTask');
  return { ...b, sessionId: id(v.sessionId, 'sessionId'), objective: str(v.objective, 'objective', MAX.text), status: oneOf(v.status ?? TaskStatus.OPEN, 'status', TaskStatus), priority: number(v.priority ?? 50, 'priority'), assignedTo: v.assignedTo === undefined ? undefined : str(v.assignedTo, 'assignedTo'), parentTaskId: v.parentTaskId === undefined ? undefined : id(v.parentTaskId, 'parentTaskId'), constraints: list(v.constraints, 'constraints', x => str(x, 'constraint'), 30), updatedAt: time(v.updatedAt, 'updatedAt') };
}
export function createClaim(input = {}) {
  const v = object(input, 'Claim'); const b = base(v, 'Claim');
  return { ...b, sessionId: id(v.sessionId, 'sessionId'), text: str(v.text, 'text', MAX.text), status: v.status === undefined ? undefined : oneOf(v.status, 'status', AdjudicationStatus), updatedAt: time(v.updatedAt, 'updatedAt') };
}
export function createSource(input = {}) {
  const v = object(input, 'Source'); const b = base(v, 'Source'); const original = url(v.url);
  let canonicalUrl = canonicalizeUrl(v.canonicalUrl === undefined ? original : url(v.canonicalUrl, 'canonicalUrl'));
  return { ...b, url: original, canonicalUrl, title: str(v.title ?? original, 'title'), publisher: str(v.publisher ?? 'Unknown publisher', 'publisher'), author: v.author === undefined ? undefined : str(v.author, 'author'), publishedAt: v.publishedAt === undefined ? undefined : time(v.publishedAt, 'publishedAt', true), sourceType: str(v.sourceType ?? 'web', 'sourceType'), quality: v.quality === undefined ? undefined : number(v.quality, 'quality'), createdAt: b.createdAt };
}
export function createEvidenceEdge(input = {}) {
  const v = object(input, 'EvidenceEdge'); const b = base(v, 'EvidenceEdge');
  return { ...b, claimId: id(v.claimId, 'claimId'), sourceId: id(v.sourceId, 'sourceId'), type: oneOf(v.type, 'type', EvidenceType), quote: str(v.quote, 'quote', MAX.quote), confidence: number(v.confidence ?? 50, 'confidence'), createdAt: b.createdAt };
}
export function createSourceRelationship(input = {}) {
  const v = object(input, 'SourceRelationship'); const b = base(v, 'SourceRelationship');
  return { ...b, sourceId: id(v.sourceId, 'sourceId'), targetSourceId: id(v.targetSourceId, 'targetSourceId'), type: oneOf(v.type, 'type', SourceRelationshipType), confidence: number(v.confidence ?? 50, 'confidence'), createdAt: b.createdAt };
}
export function createAdjudication(input = {}) {
  const v = object(input, 'Adjudication'); const b = base(v, 'Adjudication');
  const factors = plainJson(v.factors, 'factors', 5000);
  return { ...b, claimId: id(v.claimId, 'claimId'), status: oneOf(v.status, 'status', AdjudicationStatus), evidenceStrength: number(v.evidenceStrength, 'evidenceStrength'), factors, supportingSourceIds: list(v.supportingSourceIds, 'supportingSourceIds', x => id(x, 'sourceId')), contradictingSourceIds: list(v.contradictingSourceIds, 'contradictingSourceIds', x => id(x, 'sourceId')), qualifyingSourceIds: list(v.qualifyingSourceIds, 'qualifyingSourceIds', x => id(x, 'sourceId')) };
}
export function createAgentEvent(input = {}) {
  const v = object(input, 'AgentEvent'); const b = base(v, 'AgentEvent', 'timestamp');
  return { ...b, sessionId: id(v.sessionId, 'sessionId'), type: str(v.type, 'type'), actor: str(v.actor ?? 'system', 'actor'), payload: plainJson(v.payload, 'payload'), timestamp: b.timestamp };
}

export const ResearchSession = createResearchSession;
export const ResearchTask = createResearchTask;
export const Claim = createClaim;
export const Source = createSource;
export const EvidenceEdge = createEvidenceEdge;
export const SourceRelationship = createSourceRelationship;
export const Adjudication = createAdjudication;
export const AgentEvent = createAgentEvent;

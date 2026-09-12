import { createHash } from 'node:crypto';
import { AdjudicationStatus, EvidenceType, SourceRelationshipType, createAdjudication, createResearchTask } from './models.mjs';
import { canonicalizeUrl, scoreSourceQuality, tokenSetSimilarity, tokenize } from './normalization.mjs';

const clamp = (n, min = 0, max = 100) => Math.max(min, Math.min(max, Number.isFinite(n) ? n : min));
const idFor = (...parts) => {
  const hex = createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 32).split('');
  hex[12] = '5'; hex[16] = ((parseInt(hex[16], 16) & 3) | 8).toString(16);
  return [hex.slice(0, 8).join(''), hex.slice(8, 12).join(''), hex.slice(12, 16).join(''), hex.slice(16, 20).join(''), hex.slice(20).join('')].join('-');
};
const asArray = value => Array.isArray(value) ? value : [];
const oneOrMany = value => value === undefined ? [] : (Array.isArray(value) ? value : [value]);
const sourceText = source => source.content ?? source.text ?? source.excerpt ?? source.description ?? '';

function unionFind(ids) {
  const parent = new Map(ids.map(id => [id, id]));
  const find = id => { let root = parent.get(id) ?? id; while (parent.get(root) !== root) { parent.set(root, parent.get(parent.get(root))); root = parent.get(root); } return root; };
  const union = (a, b) => { if (!parent.has(a)) parent.set(a, a); if (!parent.has(b)) parent.set(b, b); const ar = find(a), br = find(b); if (ar !== br) parent.set(br, ar); };
  return { find, union };
}

/** Derive only explicit links and very strong text/canonical matches; this never fetches URLs. */
export function deriveSourceRelationships(sources = [], explicitLinks = [], options = {}) {
  if (!Array.isArray(explicitLinks) && explicitLinks && typeof explicitLinks === 'object') {
    if (explicitLinks.sourceId || explicitLinks.fromSourceId || explicitLinks.from) explicitLinks = [explicitLinks];
    else {
      options = explicitLinks;
      explicitLinks = options.explicitLinks ?? options.relationships ?? options.links ?? [];
    }
  }
  const byCanonical = new Map();
  for (const source of asArray(sources)) {
    if (!source?.id || !(source.url || source.canonicalUrl)) continue;
    const key = canonicalizeUrl(source.canonicalUrl ?? source.url);
    if (!byCanonical.has(key)) byCanonical.set(key, []);
    byCanonical.get(key).push(source);
  }
  const result = [];
  const seen = new Set();
  const add = (link, fallbackType, fallbackConfidence) => {
    if (!link) return;
    const sourceId = link.sourceId ?? link.fromSourceId ?? link.from;
    const targetSourceId = link.targetSourceId ?? link.toSourceId ?? link.to;
    if (!sourceId || !targetSourceId || sourceId === targetSourceId) return;
    const type = link.type ?? fallbackType;
    if (!Object.values(SourceRelationshipType).includes(type)) return;
    const confidence = clamp(link.confidence ?? fallbackConfidence);
    const key = [sourceId, targetSourceId, type].join('|');
    if (seen.has(key)) return; seen.add(key);
    result.push({ id: link.id ?? idFor('relationship', key), sourceId, targetSourceId, type, confidence });
  };
  for (const link of asArray(explicitLinks)) add(link, SourceRelationshipType.CITES, 95);
  for (const source of asArray(sources)) {
    for (const targetId of oneOrMany(source.derivedFrom ?? source.derivedFromSourceIds ?? source.derivedFromSourceId)) add({ sourceId: source.id, targetSourceId: targetId }, SourceRelationshipType.DERIVED_FROM, 95);
    for (const targetId of oneOrMany(source.cites ?? source.citedSourceIds ?? source.citedSourceId)) add({ sourceId: source.id, targetSourceId: targetId }, SourceRelationshipType.CITES, 95);
  }
  for (const records of byCanonical.values()) for (let i = 1; i < records.length; i++) add({ sourceId: records[i].id, targetSourceId: records[0].id }, SourceRelationshipType.POSSIBLY_SAME_ORIGIN, 100);
  const threshold = options.overlapThreshold ?? 0.92;
  const minTokens = options.minimumTokens ?? 12;
  const titleThreshold = options.titleOverlapThreshold ?? 0.84;
  for (let i = 0; i < sources.length; i++) for (let j = i + 1; j < sources.length; j++) {
    const a = sources[i], b = sources[j]; if (!a?.id || !b?.id) continue;
    const titleSimilarity = tokenSetSimilarity(a.title ?? '', b.title ?? '');
    if (tokenize(a.title ?? '').length >= 4 && titleSimilarity >= titleThreshold) add({ sourceId: a.id, targetSourceId: b.id, confidence: clamp(Math.round(titleSimilarity * 100)) }, SourceRelationshipType.POSSIBLY_SAME_ORIGIN, titleSimilarity * 100);
    const at = sourceText(a), bt = sourceText(b);
    if (!at || !bt || at.trim().split(/\s+/).length < minTokens || bt.trim().split(/\s+/).length < minTokens) continue;
    const similarity = tokenSetSimilarity(at, bt);
    if (similarity >= threshold) add({ sourceId: a.id, targetSourceId: b.id, confidence: clamp(Math.round(similarity * 100)) }, SourceRelationshipType.POSSIBLY_SAME_ORIGIN, similarity * 100);
  }
  return result;
}

/** Collapse sources connected by a relationship into correlated lineages. */
export function findSourceLineages(sources = [], relationships = []) {
  const ids = asArray(sources).map(source => source.id).filter(Boolean);
  const uf = unionFind(ids);
  for (const relation of asArray(relationships)) {
    if (relation.confidence === undefined || relation.confidence >= 70) uf.union(relation.sourceId, relation.targetSourceId);
  }
  const groups = new Map();
  for (const sourceId of ids) { const root = uf.find(sourceId); if (!groups.has(root)) groups.set(root, []); groups.get(root).push(sourceId); }
  return [...groups.values()].map(sourceIds => ({ id: sourceIds.slice().sort()[0], sourceIds: sourceIds.slice().sort() }));
}
export function mergeIndependentLineages(lineages = [], relationships = []) {
  const ids = lineages.flatMap(lineage => lineage.sourceIds ?? lineage.sources ?? []).filter(Boolean);
  const groups = findSourceLineages(ids.map(id => ({ id })), relationships);
  return groups;
}

function lineageIndex(sources, relationships) {
  const lineages = findSourceLineages(sources, relationships); const index = new Map();
  for (const lineage of lineages) for (const sourceId of lineage.sourceIds) index.set(sourceId, lineage);
  return { lineages, index };
}

/** Return one support/contradiction group per independent source lineage for each claim. */
export function calculateIndependentGroups(edges = [], sources = [], relationships = []) {
  if (!Array.isArray(edges) && edges && typeof edges === 'object') {
    const data = edges; edges = data.evidenceEdges ?? data.edges ?? []; sources = data.sources ?? []; relationships = data.sourceRelationships ?? data.relationships ?? [];
  }
  const { index } = lineageIndex(sources, relationships); const claims = new Map();
  for (const edge of asArray(edges)) {
    if (!edge?.claimId || !edge.sourceId || !Object.values(EvidenceType).includes(edge.type)) continue;
    const lineage = index.get(edge.sourceId); const lineageId = lineage?.id ?? edge.sourceId;
    if (!claims.has(edge.claimId)) claims.set(edge.claimId, { claimId: edge.claimId, SUPPORTS: new Map(), CONTRADICTS: new Map(), QUALIFIES: new Map() });
    const bucket = claims.get(edge.claimId)[edge.type];
    const prior = bucket.get(lineageId);
    if (!prior || (edge.confidence ?? 0) > (prior.confidence ?? 0)) bucket.set(lineageId, { ...edge, lineageId });
  }
  return [...claims.values()].map(item => ({ claimId: item.claimId, support: [...item.SUPPORTS.values()], contradiction: [...item.CONTRADICTS.values()], qualifies: [...item.QUALIFIES.values()] }));
}

function weighted(edges, sourceById) {
  return edges.reduce((sum, edge) => sum + ((edge.confidence ?? 50) * (scoreSourceQuality(sourceById.get(edge.sourceId) ?? {}) / 100)), 0);
}

/** Adjudicate with independent lineages only. Factors are numeric and inspectable, not hidden reasoning. */
export function adjudicateClaims(claims = [], edges = [], sources = [], relationships = [], options = {}) {
  if (!Array.isArray(claims) && claims && typeof claims === 'object') {
    const data = claims; claims = data.claims ?? []; edges = data.evidenceEdges ?? data.edges ?? []; sources = data.sources ?? []; relationships = data.sourceRelationships ?? data.relationships ?? []; options = data.options ?? {};
  }
  const sourceById = new Map(asArray(sources).map(source => [source.id, source]));
  const groups = calculateIndependentGroups(edges, sources, relationships); const byClaim = new Map(groups.map(group => [group.claimId, group]));
  const maxGroups = Math.max(1, options.expectedIndependentSources ?? 3); const output = [];
  for (const claim of asArray(claims)) {
    const group = byClaim.get(claim.id) ?? { support: [], contradiction: [], qualifies: [] };
    const support = weighted(group.support, sourceById), contradiction = weighted(group.contradiction, sourceById), qualifying = weighted(group.qualifies, sourceById);
    const supportCount = group.support.length, contradictionCount = group.contradiction.length;
    const total = support + contradiction;
    const corroboration = clamp((Math.max(supportCount, contradictionCount) / maxGroups) * 100);
    const quality = total ? clamp((support + contradiction) / (supportCount + contradictionCount)) : 0;
    const balance = total ? clamp((Math.abs(support - contradiction) / total) * 100) : 0;
    const coverage = clamp(Math.min(100, total / 2));
    const qualificationAdjustment = clamp(100 - qualifying / maxGroups);
    const evidenceStrength = Math.round(clamp(quality * 0.30 + corroboration * 0.25 + balance * 0.20 + coverage * 0.15 + qualificationAdjustment * 0.10));
    const hasSupport = supportCount > 0 && support > 0; const hasContradiction = contradictionCount > 0 && contradiction > 0;
    const threshold = options.minimumStrength ?? 35;
    let status = AdjudicationStatus.UNCERTAIN;
    if (hasSupport && hasContradiction && support >= threshold && contradiction >= threshold) status = AdjudicationStatus.MIXED;
    else if (hasSupport && support > contradiction && support >= threshold) status = AdjudicationStatus.SUPPORTED;
    else if (hasContradiction && contradiction > support && contradiction >= threshold) status = AdjudicationStatus.CONTRADICTED;
    output.push(createAdjudication({ id: idFor('adjudication', claim.id), claimId: claim.id, status, evidenceStrength, factors: { supportWeight: Math.round(clamp(support / maxGroups)), contradictionWeight: Math.round(clamp(contradiction / maxGroups)), independentSupportGroups: Math.round(clamp(supportCount, 0, 100)), independentContradictionGroups: Math.round(clamp(contradictionCount, 0, 100)), sourceQuality: Math.round(quality), corroboration: Math.round(corroboration), balance: Math.round(balance), coverage: Math.round(coverage), qualificationAdjustment: Math.round(qualificationAdjustment) }, supportingSourceIds: group.support.map(edge => edge.sourceId), contradictingSourceIds: group.contradiction.map(edge => edge.sourceId), qualifyingSourceIds: group.qualifies.map(edge => edge.sourceId) }));
  }
  return output;
}
export const adjudicateClaimSet = adjudicateClaims;
export const findIndependentLineages = findSourceLineages;
export const findIndependentSourceLineages = findSourceLineages;
export const mergeSourceLineages = mergeIndependentLineages;
export const calculateIndependentEvidenceGroups = calculateIndependentGroups;
export const getIndependentEvidenceGroups = calculateIndependentGroups;
export function adjudicateClaim(claim, edges = [], sources = [], relationships = [], options = {}) {
  return adjudicateClaims([claim], edges, sources, relationships, options)[0];
}

export function detectWeakClaims(claims = [], adjudications = [], options = {}) {
  if (!Array.isArray(claims) && claims && typeof claims === 'object') {
    const data = claims; claims = data.claims ?? []; adjudications = data.adjudications ?? []; options = data.options ?? {};
  }
  const minimum = options.minimumStrength ?? 60;
  const byId = new Map(asArray(adjudications).map(item => [item.claimId, item]));
  return asArray(claims).filter(claim => { const a = byId.get(claim.id); return !a || a.evidenceStrength < minimum || a.status === AdjudicationStatus.UNCERTAIN || a.status === AdjudicationStatus.MIXED; }).map(claim => {
    const a = byId.get(claim.id); const reasons = !a ? ['no adjudication'] : [a.status === AdjudicationStatus.MIXED ? 'conflicting independent evidence' : a.status === AdjudicationStatus.UNCERTAIN ? 'insufficient evidence' : 'low evidence strength'];
    return { claim, adjudication: a, reasons };
  });
}

export function generateFollowUpTaskSpecs(weakClaims = [], options = {}) {
  if (!Array.isArray(weakClaims) && weakClaims && typeof weakClaims === 'object') {
    const data = weakClaims; weakClaims = data.weakClaims ?? data.claims ?? []; options = data.options ?? data;
  }
  const max = Math.max(0, Math.min(options.maxTasks ?? 5, 50));
  return asArray(weakClaims).slice(0, max).map(item => {
    const claim = item.claim ?? item; const sessionId = claim.sessionId ?? options.sessionId;
    const objective = `Find an independent source that directly tests this claim: ${String(claim.text ?? '').slice(0, 1900)}`;
    const constraints = ['Prefer an independent primary source', 'Record a short supporting or contradicting quote'];
    if (!sessionId) return { claimId: claim.id, objective, constraints };
    return { ...createResearchTask({ id: idFor('follow-up', claim.id), sessionId, objective, priority: options.priority ?? 70, constraints }), claimId: claim.id };
  });
}
export const generateFollowUpTasks = generateFollowUpTaskSpecs;

export function buildGraphPayload({ sessions = [], session, tasks = [], claims = [], sources = [], evidenceEdges = [], sourceRelationships = [], adjudications = [] } = {}) {
  sessions = sessions.length ? sessions : session ? [session] : [];
  const entities = [
    ...asArray(sessions).map(entity => ({ id: entity.id, type: 'session', label: entity.title ?? entity.id, entity })),
    ...asArray(tasks).map(entity => ({ id: entity.id, type: 'task', label: entity.objective ?? entity.id, entity })),
    ...asArray(claims).map(entity => ({ id: entity.id, type: 'claim', label: entity.text ?? entity.id, entity })),
    ...asArray(sources).map(entity => ({ id: entity.id, type: 'source', label: entity.title ?? entity.id, entity })),
    ...asArray(adjudications).map(entity => ({ id: entity.id, type: 'adjudication', label: entity.status, entity }))
  ];
  const rootSession = asArray(sessions)[0];
  const edges = [
    ...(rootSession ? asArray(claims).map(claim => ({ id: idFor('question-claim', rootSession.id, claim.id), source: rootSession.id, target: claim.id, type: 'ASKS' })) : []),
    ...asArray(evidenceEdges).map(edge => ({ id: edge.id, source: edge.sourceId, target: edge.claimId, type: edge.type, entity: edge })),
    ...asArray(sourceRelationships).map(edge => ({ id: edge.id, source: edge.sourceId, target: edge.targetSourceId, type: edge.type, entity: edge })),
    ...asArray(tasks).filter(task => task.parentTaskId).map(task => ({ id: idFor('parent', task.id), source: task.parentTaskId, target: task.id, type: 'PARENT_OF' }))
  ];
  return { nodes: entities, edges };
}

/** Render only claims, sources and evidence edges supplied by the caller; no citations are invented. */
export function buildCitationSafeReport({ claims = [], sources = [], evidenceEdges = [], adjudications = [] } = {}) {
  const sourceById = new Map(asArray(sources).map(source => [source.id, source]));
  const adjudicationByClaim = new Map(asArray(adjudications).map(a => [a.claimId, a]));
  const claimsOut = asArray(claims).map(claim => {
    const adjudication = adjudicationByClaim.get(claim.id);
    const evidence = asArray(evidenceEdges).filter(edge => edge.claimId === claim.id && sourceById.has(edge.sourceId)).map(edge => {
      const source = sourceById.get(edge.sourceId);
      return { type: edge.type, confidence: edge.confidence, quote: edge.quote, citation: { sourceId: source.id, title: source.title, url: source.url ?? source.canonicalUrl } };
    });
    return { claimId: claim.id, text: claim.text, status: adjudication?.status ?? AdjudicationStatus.UNCERTAIN, evidenceStrength: adjudication?.evidenceStrength ?? 0, evidence };
  });
  return { title: 'ClaimLens evidence report', claims: claimsOut };
}
export const createGraphPayload = buildGraphPayload;
export const createCitationSafeReport = buildCitationSafeReport;
export const buildReport = buildCitationSafeReport;

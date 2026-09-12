import { randomUUID } from 'node:crypto';
import { createClaim, createEvidenceEdge, EvidenceType } from '../domain/models.mjs';
import { normalizeText, tokenSetSimilarity, tokenize } from '../domain/normalization.mjs';
import { sourceExcerpt } from './fetch-source.mjs';

const NEGATIVE = /\b(no evidence|not|unlikely|delay|delays|delayed|miss|missed|fail|fails|failed|failure|risk|risks|caveat|caveats|limitation|limitations|concern|concerns|critic|criticism|contradict|uncertain|slower|shortfall|challenge|challenges|barrier|barriers|hurdle|hurdles|obstacle|obstacles|however|but|won't|cannot|can't|doesn't|before 2030|years from|far from)\b/i;
const QUALIFIER = /\b(may|could|might|depends|uncertain|limited|mixed|caveat|however|although|while|risk|estimate|forecast|expected|potential)\b/i;
const STRONG_NEGATIVE = /\b(no evidence|not|unlikely|delayed|fails?|failed|failure|won't|cannot|can't|doesn't|before 2030|years from|far from|shortfall|challenge|challenges|barrier|barriers|hurdle|hurdles|obstacle|obstacles|criticism|criticisms|concern|concerns)\b/i;
const NOISE = /^(read more|click here|subscribe|sign up|advertisement|cookie|all rights reserved|share this)/i;

function sentences(text) {
  return String(text ?? '').replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/).map((part) => part.trim()).filter((part) => {
    const words = tokenize(part);
    return words.length >= 8 && words.length <= 55 && !NOISE.test(part);
  });
}

function propositionFromQuestion(question) {
  const clean = String(question ?? '').replace(/[?]+$/, '').trim();
  return clean ? `The evidence base is being evaluated for this proposition: ${clean}.` : 'The evidence base is still being evaluated.';
}

function relevance(claim, source) {
  const sourceText = `${source.title ?? ''} ${sourceExcerpt(source, 1800)}`;
  return tokenSetSimilarity(claim.text, sourceText);
}

export function extractClaims(question, sources = [], { sessionId, maxClaims = 6 } = {}) {
  const candidates = [];
  for (const source of sources) {
    for (const sentence of sentences(source.content || source.excerpt || source.snippet || source.title)) {
      const score = relevance({ text: sentence }, source) + (source.searchRole === 'SKEPTIC' ? 0.015 : 0);
      candidates.push({ text: sentence, sourceId: source.id, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  const chosen = [];
  for (const candidate of candidates) {
    if (chosen.some((item) => tokenSetSimilarity(item.text, candidate.text) >= 0.62)) continue;
    chosen.push(candidate);
    if (chosen.length >= Math.max(1, maxClaims - 1)) break;
  }
  const centralText = propositionFromQuestion(question);
  if (!chosen.length) chosen.push({ text: centralText, sourceId: undefined, score: 0 });
  if (chosen.length === 1 && sources.length > 1) {
    const second = sources.find((source) => source.id !== chosen[0].sourceId);
    const sentence = sentences(second?.content || second?.excerpt || second?.snippet || '')[0];
    if (sentence && !chosen.some((item) => tokenSetSimilarity(item.text, sentence) >= 0.62)) chosen.push({ text: sentence, sourceId: second.id, score: relevance({ text: sentence }, second) });
  }
  const central = { ...createClaim({ id: randomUUID(), sessionId, text: centralText }), isCentral: true, extractionScore: 0 };
  const extracted = chosen.filter((candidate) => candidate.text !== centralText).slice(0, Math.max(0, maxClaims - 1)).map((candidate) => ({
    ...createClaim({ id: randomUUID(), sessionId, text: candidate.text }),
    originSourceId: candidate.sourceId,
    extractionScore: Math.round(candidate.score * 100),
  }));
  return [central, ...extracted].slice(0, maxClaims);
}

function bestQuote(claim, source) {
  const sourceSentences = sentences(source.content || source.excerpt || source.snippet || source.title);
  const target = sourceSentences.sort((a, b) => relevance(claim, { ...source, excerpt: b }) - relevance(claim, { ...source, excerpt: a }))[0];
  return (target || sourceExcerpt(source, 420) || source.title).slice(0, 600);
}

export function classifyEvidence(claim, source, { role = source.searchRole ?? 'RESEARCHER' } = {}) {
  const excerpt = sourceExcerpt(source, 1800);
  const haystack = `${source.title ?? ''} ${excerpt}`;
  const overlap = relevance(claim, source);
  const isSkeptic = role === 'SKEPTIC' || role === 'FOLLOW_UP';
  let type = EvidenceType.SUPPORTS;
  let explanation = 'The source contains language relevant to the claim.';
  if (isSkeptic && STRONG_NEGATIVE.test(haystack)) {
    type = EvidenceType.CONTRADICTS;
    explanation = 'Skeptic retrieval surfaced language that directly challenges the claim.';
  } else if ((NEGATIVE.test(haystack) && isSkeptic) || QUALIFIER.test(haystack) || isSkeptic) {
    type = EvidenceType.QUALIFIES;
    explanation = isSkeptic ? 'Skeptic retrieval surfaced a relevant condition or alternative perspective.' : 'The source qualifies the claim with conditions, uncertainty, or scope.';
  }
  const confidence = Math.max(20, Math.min(96, Math.round(38 + overlap * 46 + (source.quality ?? 50) * 0.12 + (isSkeptic ? 3 : 0))));
  const edge = createEvidenceEdge({ id: randomUUID(), claimId: claim.id, sourceId: source.id, type, quote: bestQuote(claim, source), confidence });
  return { ...edge, strength: Math.round(overlap * 100), directness: Math.round(Math.min(100, overlap * 125)), explanation, role };
}

export function evidenceEdgesFor(claims, sources) {
  const edges = [];
  for (const source of sources) {
    for (const claim of claims) {
      const overlap = relevance(claim, source);
      const threshold = claim.isCentral ? 0.16 : claim.originSourceId === source.id ? 0 : 0.045;
      if (overlap >= threshold && (overlap > 0 || claim.originSourceId === source.id)) edges.push(classifyEvidence(claim, source));
    }
  }
  return edges;
}

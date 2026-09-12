import { randomUUID } from 'node:crypto';
import { createClaim, createEvidenceEdge, EvidenceType } from '../domain/models.mjs';
import { normalizeText, tokenSetSimilarity, tokenize } from '../domain/normalization.mjs';
import { sourceExcerpt } from './fetch-source.mjs';

const NEGATIVE = /\b(no evidence|not|unlikely|delay|delays|delayed|miss|missed|fail|fails|failed|failure|risk|risks|caveat|caveats|limitation|limitations|concern|concerns|critic|criticism|contradict|uncertain|slower|shortfall|challenge|challenges|barrier|barriers|hurdle|hurdles|obstacle|obstacles|however|but|won't|cannot|can't|doesn't|before 2030|years from|far from)\b/i;
const QUALIFIER = /\b(may|could|might|depends|uncertain|limited|mixed|caveat|however|although|while|risk|estimate|forecast|expected|potential)\b/i;
const STRONG_NEGATIVE = /\b(no evidence|no benefit|not protective|not associated|not causal|does not (?:reduce|protect|prevent|improve)|doesn't (?:reduce|protect|prevent|improve)|increased risk|harm(?:s|ful)?|adverse|illusion|bias|confounding|reverse causation|unlikely|delayed|fails?|failed|failure|won't|cannot|can't|doesn't|before 2030|years from|far from|shortfall|challenge|challenges|barrier|barriers|hurdle|hurdles|obstacle|obstacles|criticism|criticisms|concern|concerns)\b/i;
const NOISE = /^(read more|click here|subscribe|sign up|advertisement|cookie|all rights reserved|share this)/i;
const META = /(read (the )?report here|click (the )?link|subscribe to|cookie preferences|all rights reserved|privacy policy)/i;
const FACTUAL_VERB = /\b(is|are|was|were|has|have|had|can|could|may|might|will|would|does|do|shows?|finds?|found|reports?|reported|suggests?|associated|causes?|increases?|decreases?|reaches?|remain|remains|depends|requires|indicates?)\b/i;
const DIRECT_SUPPORT = /\b(cause|causes|caused|leading cause|associated with|decrease(?:s|d)?|reduce(?:s|d)?|improve(?:s|d)?|effective|evidence (?:shows?|supports?|suggests?)|demonstrates?|finds?|reports?)\b/i;
const TOPIC_STOPWORDS = new Set('a an are as at be been being by can could did does for from has have how if in is it its may more of on or should than that the their them they this to was were what when where which who why will with would'.split(' '));

function sentences(text) {
  return String(text ?? '').replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/).map((part) => part.trim()).filter((part) => {
    const words = tokenize(part);
    return words.length >= 8 && words.length <= 55 && !NOISE.test(part) && !META.test(part) && !/[?]$/.test(part) && FACTUAL_VERB.test(part);
  });
}

function propositionFromQuestion(question) {
  const clean = String(question ?? '').replace(/[?]+$/, '').trim();
  return clean ? `The evidence base is being evaluated for this proposition: ${clean}.` : 'The evidence base is still being evaluated.';
}

function topicText(claim) {
  return claim.isCentral ? String(claim.text ?? '').replace(/^The evidence base is being evaluated for this proposition:\s*/i, '').replace(/[.?!]+$/, '') : String(claim.text ?? '');
}
function topicKey(token) {
  if (token.endsWith('ies') && token.length > 4) return `${token.slice(0, -3)}y`;
  if (token.endsWith('s') && token.length > 4) return token.slice(0, -1);
  return token;
}
function topicCoverage(text, question) {
  const left = new Set(tokenize(text).filter((token) => !TOPIC_STOPWORDS.has(token)).map(topicKey));
  const right = new Set(tokenize(question).filter((token) => !TOPIC_STOPWORDS.has(token)).map(topicKey));
  if (!right.size) return 0;
  let overlap = 0; for (const token of right) if (left.has(token) || [...left].some((candidate) => candidate.length >= 5 && (candidate.startsWith(token) || token.startsWith(candidate)))) overlap++;
  return overlap / right.size;
}
function relevance(claim, source) {
  const sourceText = `${source.title ?? ''} ${sourceExcerpt(source, 1800)}`;
  return tokenSetSimilarity(topicText(claim), sourceText);
}

export function extractClaims(question, sources = [], { sessionId, maxClaims = 6 } = {}) {
  const candidates = [];
  for (const source of sources) {
    const titleCoverage = topicCoverage(source.title || '', question);
    for (const sentence of sentences(source.content || source.excerpt || source.snippet || source.title)) {
      const sentenceCoverage = topicCoverage(sentence, question);
      if (sentenceCoverage < 0.10 && titleCoverage < 0.10) continue;
      const score = sentenceCoverage * 0.68 + titleCoverage * 0.17 + relevance({ text: sentence }, source) * 0.15 + (source.searchRole === 'SKEPTIC' ? 0.015 : 0);
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
  if (!chosen.length) {
    const fallback = sources.flatMap((source) => sentences(source.content || source.excerpt || source.snippet || source.title).map((text) => ({ text, sourceId: source.id, score: 0 })))[0];
    if (fallback) chosen.push(fallback);
  }
  if (chosen.length === 1 && sources.length > 1) {
    const second = sources.find((source) => source.id !== chosen[0].sourceId);
    const sentence = sentences(second?.content || second?.excerpt || second?.snippet || '').find((item) => topicCoverage(item, question) >= 0.10 || topicCoverage(second?.title || '', question) >= 0.20);
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
  const quote = bestQuote(claim, source);
  const haystack = `${source.title ?? ''} ${quote}`;
  const overlap = relevance(claim, source);
  const isSkeptic = role === 'SKEPTIC' || role === 'FOLLOW_UP';
  let type = EvidenceType.SUPPORTS;
  let explanation = 'The source contains language relevant to the claim.';
  const directSupport = DIRECT_SUPPORT.test(quote) && !STRONG_NEGATIVE.test(quote);
  if (isSkeptic && STRONG_NEGATIVE.test(haystack)) {
    type = EvidenceType.CONTRADICTS;
    explanation = 'Skeptic retrieval surfaced language that directly challenges the claim.';
  } else if (!isSkeptic && directSupport) {
    type = EvidenceType.SUPPORTS;
    explanation = 'The matched passage states a direct result or relationship relevant to the claim.';
  } else if ((NEGATIVE.test(haystack) && isSkeptic) || QUALIFIER.test(haystack) || isSkeptic) {
    type = EvidenceType.QUALIFIES;
    explanation = isSkeptic ? 'Skeptic retrieval surfaced a relevant condition or alternative perspective.' : 'The source qualifies the claim with conditions, uncertainty, or scope.';
  }
  const confidence = Math.max(20, Math.min(96, Math.round(38 + overlap * 46 + (source.quality ?? 50) * 0.12 + (isSkeptic ? 3 : 0))));
  const edge = createEvidenceEdge({ id: randomUUID(), claimId: claim.id, sourceId: source.id, type, quote, confidence });
  return { ...edge, strength: Math.round(overlap * 100), directness: Math.round(Math.min(100, overlap * 125)), explanation, role };
}

export function evidenceEdgesFor(claims, sources) {
  const edges = [];
  for (const source of sources) {
    if (source.fetchError && sourceExcerpt(source, 1800).trim().length < 20) continue;
    for (const claim of claims) {
      const overlap = relevance(claim, source);
      const threshold = claim.isCentral ? 0.16 : claim.originSourceId === source.id ? 0 : 0.045;
      if (overlap >= threshold && (overlap > 0 || claim.originSourceId === source.id)) edges.push(classifyEvidence(claim, source));
    }
  }
  return edges;
}

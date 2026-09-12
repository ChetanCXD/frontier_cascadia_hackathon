import { fetchWithTimeout, stripMarkup } from './search.mjs';
import { canonicalizeUrl, scoreSourceQuality } from '../domain/normalization.mjs';

const MAX_HTML = 1_200_000;
const BLOCKED_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]']);

function assertPublicHttpUrl(value) {
  const parsed = new URL(value);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only HTTP(S) source URLs are allowed');
  if (BLOCKED_HOSTS.has(parsed.hostname.toLowerCase()) || parsed.hostname.endsWith('.local')) throw new Error('Private source hosts are not allowed');
  return parsed;
}

function firstMatch(html, expressions) {
  for (const expression of expressions) { const match = html.match(expression); if (match?.[1]) return stripMarkup(match[1]); }
  return '';
}

function parseDate(value) {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function htmlToText(html) {
  return stripMarkup(html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<\/(p|div|article|section|li|h[1-6]|br|tr)>/gi, '. '));
}

function extractLinks(html, baseUrl) {
  const links = [];
  for (const match of html.matchAll(/<a[^>]+href=["']([^"']+)["'][^>]*>/gi)) {
    try {
      const url = new URL(match[1], baseUrl).toString();
      if (/^https?:\/\//i.test(url)) links.push(canonicalizeUrl(url));
    } catch { /* malformed links are not provenance */ }
  }
  return [...new Set(links)].slice(0, 100);
}

function inferSourceType(url, title, text) {
  const host = new URL(url).hostname.toLowerCase();
  const haystack = `${host} ${title} ${text.slice(0, 1400)}`.toLowerCase();
  if (host.endsWith('.gov') || host.includes('.gov.')) return 'government';
  if (host.endsWith('.edu')) return 'academic';
  if (/doi\.org|arxiv\.org|nature\.com|science\.org|ncbi\.nlm\.nih\.gov/.test(host)) return 'peer-reviewed';
  if (/press release|newsroom|official announcement|company blog/.test(haystack)) return 'press-release';
  if (/reuters|apnews|bbc|nytimes|theguardian|washingtonpost|wsj|ft\.com/.test(host)) return 'news';
  if (/analysis|research|institute|policy/.test(haystack)) return 'analysis';
  return 'web';
}

function publisherFor(url) {
  return new URL(url).hostname.replace(/^www\./i, '');
}

export async function fetchSource(url, { searchResult = {}, role = 'RESEARCHER', fetchImpl = globalThis.fetch, timeoutMs = 8_000 } = {}) {
  const parsed = assertPublicHttpUrl(url);
  const canonicalUrl = canonicalizeUrl(parsed.toString());
  let response;
  try {
    response = await fetchWithTimeout(canonicalUrl, { headers: { 'user-agent': 'ClaimLens/0.1 (evidence debugger)', accept: 'text/html,application/xhtml+xml,text/plain;q=0.8' } }, timeoutMs, fetchImpl);
  } catch (error) {
    return {
      url: parsed.toString(), canonicalUrl, title: searchResult.title || parsed.hostname, publisher: publisherFor(canonicalUrl),
      snippet: searchResult.snippet || '', excerpt: searchResult.snippet || '', content: searchResult.snippet || '',
      sourceType: 'web', searchRole: role, retrievedAt: new Date().toISOString(), fetchError: error?.message ?? 'Source request failed', links: [],
    };
  }
  if (!response.ok) {
    return {
      url: parsed.toString(), canonicalUrl, title: searchResult.title || parsed.hostname, publisher: publisherFor(canonicalUrl),
      snippet: searchResult.snippet || '', excerpt: searchResult.snippet || '', content: searchResult.snippet || '',
      sourceType: 'web', searchRole: role, retrievedAt: new Date().toISOString(), fetchError: `HTTP ${response.status}`, links: [],
    };
  }
  const raw = (await response.text()).slice(0, MAX_HTML);
  const title = firstMatch(raw, [/<title[^>]*>([\s\S]*?)<\/title>/i, /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i]) || searchResult.title || parsed.hostname;
  const description = firstMatch(raw, [/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)/i, /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)/i]);
  const text = htmlToText(raw);
  const excerptSource = String(searchResult.snippet ?? '').trim().length >= 8 ? searchResult.snippet : [description, text, searchResult.snippet].find((value) => String(value ?? '').trim().length > 20) || searchResult.snippet || description || text || '';
  const excerpt = String(excerptSource).slice(0, 900);
  const content = text.trim().length > 20 ? text.slice(0, 80_000) : excerpt;
  const fetchError = content.trim().length > 20 ? undefined : 'No readable page text extracted';
  const publishedAt = parseDate(firstMatch(raw, [/<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']+)/i, /<meta[^>]+name=["']date["'][^>]+content=["']([^"']+)/i, /<time[^>]+datetime=["']([^"']+)/i]));
  const author = firstMatch(raw, [/<meta[^>]+name=["']author["'][^>]+content=["']([^"']+)/i, /<meta[^>]+property=["']article:author["'][^>]+content=["']([^"']+)/i]) || undefined;
  const sourceType = inferSourceType(canonicalUrl, title, text);
  const source = {
    url: parsed.toString(), canonicalUrl, title: title.slice(0, 500), publisher: publisherFor(canonicalUrl), author,
    publishedAt, sourceType, sourceKind: ['government', 'academic', 'peer-reviewed', 'press-release'].includes(sourceType) ? 'PRIMARY' : 'SECONDARY',
    quality: scoreSourceQuality({ sourceType, publisher: publisherFor(canonicalUrl), title, author, publishedAt, url: canonicalUrl }),
    snippet: searchResult.snippet || '', excerpt, content, links: extractLinks(raw, canonicalUrl),
    searchRole: role, retrievedAt: new Date().toISOString(), fetchError,
  };
  return source;
}

export function sourceExcerpt(source, max = 480) {
  return String(source?.excerpt || source?.snippet || source?.content || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

const DEFAULT_TIMEOUT_MS = 9_000;

function decodeHtml(value = '') {
  return value
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([\da-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>');
}

export function stripMarkup(value = '') {
  return decodeHtml(String(value).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

export function unwrapSearchUrl(value) {
  if (!value) return '';
  const raw = decodeHtml(value);
  try {
    const url = new URL(raw, 'https://duckduckgo.com');
    const encoded = url.searchParams.get('uddg');
    return encoded ? decodeURIComponent(encoded) : url.toString();
  } catch { return raw; }
}

function requestInit(method = 'GET', body, headers = {}) {
  return { method, headers: { 'user-agent': 'ClaimLens/0.1 (evidence research demo)', accept: 'application/json,text/html;q=0.9,*/*;q=0.7', ...headers }, ...(body ? { body } : {}) };
}

export async function fetchWithTimeout(url, init = {}, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') throw new Error('Fetch is unavailable in this Node runtime');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetchImpl(url, { ...init, signal: controller.signal }); }
  finally { clearTimeout(timeout); }
}

function parseDuckDuckGo(html, limit) {
  const results = [];
  const blockPattern = /<div[^>]+class=["'][^"']*result[^"']*["'][\s\S]*?<\/div>\s*<\/div>/gi;
  const blocks = html.match(blockPattern) ?? [];
  const parseBlock = (block) => {
    const anchor = block.match(/<a[^>]+class=["'][^"']*result__a[^"']*["'][^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i)
      ?? block.match(/<a[^>]+href=["']([^"']+)["'][^>]*class=["'][^"']*result__a[^"']*["'][^>]*>([\s\S]*?)<\/a>/i);
    if (!anchor) return null;
    const snippetMatch = block.match(/<a[^>]+class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/a>/i)
      ?? block.match(/<div[^>]+class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
    const url = unwrapSearchUrl(anchor[1]);
    if (!/^https?:\/\//i.test(url)) return null;
    return { title: stripMarkup(anchor[2]), url, snippet: stripMarkup(snippetMatch?.[1] ?? '') };
  };
  for (const block of blocks) { const result = parseBlock(block); if (result) results.push(result); }
  if (!results.length) {
    const anchors = [...html.matchAll(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)];
    for (const match of anchors) {
      const url = unwrapSearchUrl(match[1]);
      const title = stripMarkup(match[2]);
      if (/^https?:\/\//i.test(url) && title.length > 5 && !/duckduckgo/i.test(url)) results.push({ title, url, snippet: '' });
    }
  }
  const seen = new Set();
  return results.filter((result) => { if (seen.has(result.url)) return false; seen.add(result.url); return true; }).slice(0, limit);
}

function normalizeProviderResult(result = {}) {
  const url = result.url ?? result.link ?? result.href;
  if (!url || !/^https?:\/\//i.test(url)) return null;
  return { title: stripMarkup(result.title ?? result.name ?? url), url, snippet: stripMarkup(result.snippet ?? result.description ?? result.content ?? '') };
}

export class SearchClient {
  constructor({ fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS, env = process.env } = {}) {
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.env = env;
  }

  async search(query, { limit = 6, role = 'RESEARCHER' } = {}) {
    const trimmed = String(query ?? '').trim();
    if (!trimmed) return { query: trimmed, role, provider: 'none', results: [], errors: ['Search query is empty'] };
    const errors = [];
    const configured = String(this.env.SEARCH_PROVIDER ?? 'auto').toLowerCase();
    const providers = configured === 'auto' ? ['brave', 'tavily', 'serper', 'duckduckgo'] : [configured, ...(configured === 'duckduckgo' ? [] : ['duckduckgo'])];
    for (const provider of providers) {
      try {
        const results = provider === 'brave' ? await this.searchBrave(trimmed, limit) : provider === 'tavily' ? await this.searchTavily(trimmed, limit) : provider === 'serper' ? await this.searchSerper(trimmed, limit) : await this.searchDuckDuckGo(trimmed, limit);
        if (results.length) return { query: trimmed, role, provider, results, errors };
        errors.push(`${provider}: no results`);
      } catch (error) { errors.push(`${provider}: ${error?.message ?? 'request failed'}`); }
    }
    return { query: trimmed, role, provider: 'none', results: [], errors };
  }

  async searchBrave(query, limit) {
    if (!this.env.BRAVE_SEARCH_API_KEY) throw new Error('BRAVE_SEARCH_API_KEY is not configured');
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${Math.min(limit, 20)}`;
    const response = await fetchWithTimeout(url, requestInit('GET', undefined, { 'x-subscription-token': this.env.BRAVE_SEARCH_API_KEY }), this.timeoutMs, this.fetchImpl);
    if (!response.ok) throw new Error(`Brave returned HTTP ${response.status}`);
    const body = await response.json();
    return (body.web?.results ?? []).map(normalizeProviderResult).filter(Boolean).slice(0, limit);
  }

  async searchTavily(query, limit) {
    if (!this.env.TAVILY_API_KEY) throw new Error('TAVILY_API_KEY is not configured');
    const response = await fetchWithTimeout('https://api.tavily.com/search', requestInit('POST', JSON.stringify({ api_key: this.env.TAVILY_API_KEY, query, search_depth: 'basic', max_results: Math.min(limit, 20), include_answer: false }), { 'content-type': 'application/json' }), this.timeoutMs, this.fetchImpl);
    if (!response.ok) throw new Error(`Tavily returned HTTP ${response.status}`);
    const body = await response.json();
    return (body.results ?? []).map(normalizeProviderResult).filter(Boolean).slice(0, limit);
  }

  async searchSerper(query, limit) {
    if (!this.env.SERPER_API_KEY) throw new Error('SERPER_API_KEY is not configured');
    const response = await fetchWithTimeout('https://google.serper.dev/search', requestInit('POST', JSON.stringify({ q: query, num: Math.min(limit, 20) }), { 'content-type': 'application/json', 'x-api-key': this.env.SERPER_API_KEY }), this.timeoutMs, this.fetchImpl);
    if (!response.ok) throw new Error(`Serper returned HTTP ${response.status}`);
    const body = await response.json();
    return (body.organic ?? []).map(normalizeProviderResult).filter(Boolean).slice(0, limit);
  }

  async searchDuckDuckGo(query, limit) {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const response = await fetchWithTimeout(url, requestInit(), this.timeoutMs, this.fetchImpl);
    if (!response.ok) throw new Error(`DuckDuckGo returned HTTP ${response.status}`);
    const html = await response.text();
    return parseDuckDuckGo(html, limit);
  }
}

export { parseDuckDuckGo, decodeHtml };

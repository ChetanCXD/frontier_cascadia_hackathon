/* ClaimLens is intentionally dependency-free: the API is the source of truth. */
(() => {
  'use strict';

  const app = document.getElementById('app');
  const state = {
    route: 'landing', id: null, data: null, loading: false, error: '', selected: null,
    reportOpen: false, demo: { checked: false, available: false, payload: null },
    eventCursor: 0, pollTimer: null, abort: null, graphZoom: 1, disputedOnly: false
  };
  const roles = [
    ['researcher', 'Researcher'], ['skeptic', 'Skeptic'],
    ['independence', 'Independence auditor'], ['auditor', 'Independence auditor'],
    ['adjudicator', 'Adjudicator'], ['follow', 'Follow-up']
  ];

  const esc = value => String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const text = (...values) => values.find(v => v !== undefined && v !== null && String(v).trim() !== '') || '';
  const arr = value => Array.isArray(value) ? value : [];
  const obj = value => value && typeof value === 'object' ? value : {};
  const idOf = x => String(text(obj(x).id, obj(x)._id, obj(x).claimId, obj(x).sourceId, x));
  const labelOf = (x, fallback = '') => text(obj(x).title, obj(x).name, obj(x).label, obj(x).claim, obj(x).text, fallback);
  const formatDate = value => { const d = new Date(value); return value && !Number.isNaN(d.valueOf()) ? d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'Time not recorded'; };
  const api = async (url, options = {}) => {
    const response = await fetch(url, { ...options, headers: { 'Accept': 'application/json', ...(options.headers || {}) } });
    let payload = null;
    try { payload = await response.json(); } catch (_) { /* empty error body */ }
    if (!response.ok) { const detail = typeof obj(payload).error === 'object' ? obj(payload).error.message : obj(payload).error; const error = new Error(text(detail, obj(payload).message, `Request failed (${response.status})`)); error.status = response.status; throw error; }
    return payload;
  };
  const safeUrl = value => { try { const u = new URL(String(value), location.origin); return ['http:', 'https:'].includes(u.protocol) ? u.href : '#'; } catch (_) { return '#'; } };
  const sessionQuestion = data => text(obj(data).session?.question, obj(data).question, obj(data).session?.title, 'Untitled investigation');
  const sessionStatus = data => String(text(obj(data).session?.status, obj(data).status, obj(data).session?.state, 'starting')).toLowerCase();
  const dataArray = (data, key) => arr(obj(data)[key]);
  const claims = () => dataArray(state.data, 'claims');
  const sources = () => dataArray(state.data, 'sources');

  function navigate(hash) {
    if (location.hash !== hash) location.hash = hash; else route();
  }
  function parseRoute() {
    const match = location.hash.match(/^#\/research\/([^/]+)$/);
    return match ? { route: 'research', id: decodeURIComponent(match[1]) } : { route: 'landing', id: null };
  }
  function onHash() {
    const next = parseRoute();
    if (state.pollTimer) clearTimeout(state.pollTimer);
    state.route = next.route; state.id = next.id; state.data = null; state.error = ''; state.selected = null; state.eventCursor = 0; state.reportOpen = false; state.graphZoom = 1;
    if (next.route === 'research') loadSession(); else renderLanding();
  }

  async function checkDemo() {
    try { const payload = await api('/api/demo'); state.demo = { checked: true, available: Boolean(payload && (payload.sessionId || payload.session || payload.id)), payload }; }
    catch (error) { state.demo = { checked: true, available: error.status !== 404 ? false : false, payload: null }; }
    if (state.route === 'landing') renderLanding();
  }
  function renderLanding() {
    const demo = state.demo.available ? `<button class="button button-quiet" data-action="demo">Open saved demo <span aria-hidden="true">↗</span></button>` : `<p class="honest-state"><span class="status-dot"></span>${state.demo.checked ? 'No saved demo is available yet.' : 'Checking whether a real saved demo exists…'}</p>`;
    app.innerHTML = `<main class="landing">
      <nav class="landing-nav"><a class="brand" href="#/" aria-label="ClaimLens home"><span class="brand-mark">CL</span><span>ClaimLens</span></a><span class="nav-note">Evidence debugger</span></nav>
      <section class="hero" aria-labelledby="hero-title"><div class="eyebrow">RESEARCH WITH RECEIPTS</div><h1 id="hero-title">Research that tries to<br><em>prove itself wrong.</em></h1><p class="hero-copy">ClaimLens makes the argument visible: who looked, what they found, where sources disagree, and why the agent kept researching.</p>
      <form id="question-form" class="question-form"><label for="question">What should we investigate?</label><div class="input-wrap"><textarea id="question" name="question" rows="2" required maxlength="2000" placeholder="e.g. Does remote work improve long-term productivity?"></textarea><button class="button button-primary" type="submit">Investigate <span aria-hidden="true">→</span></button></div><div class="form-meta"><button class="example" type="button" data-action="example">Try an example</button><span>Every conclusion stays linked to its evidence.</span></div></form>
      <div class="landing-foot"><div><span class="section-kicker">WORKSPACE</span><h2>Not a chat transcript.</h2><p>Follow claims through support, contradiction, qualification, and provenance in one research workspace.</p></div><div class="demo-slot">${demo}</div></div>
      </section><footer class="landing-footer"><span>CLAIMLENS / RESEARCH INFRASTRUCTURE</span><span>Nothing here is pre-filled.</span></footer>
    </main>`;
    document.getElementById('question-form')?.addEventListener('submit', createSession);
    app.querySelector('[data-action="example"]')?.addEventListener('click', () => { const q = document.getElementById('question'); q.value = 'Does remote work improve long-term productivity?'; q.focus(); });
    app.querySelector('[data-action="demo"]')?.addEventListener('click', () => openDemo());
  }
  async function openDemo() {
    try { const payload = state.demo.payload || await api('/api/demo'); const id = text(payload.sessionId, payload.session?.id, payload.id); if (id) navigate(`#/research/${encodeURIComponent(id)}`); else showToast('The saved demo has no session id.'); }
    catch (_) { showToast('The saved demo could not be opened.'); }
  }
  async function createSession(event) {
    event.preventDefault(); const q = document.getElementById('question')?.value.trim(); if (!q) return;
    const button = event.target.querySelector('button[type="submit"]'); if (button) { button.disabled = true; button.textContent = 'Starting…'; }
    try { const payload = await api('/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: q }) }); const id = text(payload.sessionId, payload.session?.id, payload.id, obj(payload.data).sessionId); if (!id) throw new Error('The API did not return a session id.'); navigate(`#/research/${encodeURIComponent(id)}`); }
    catch (error) { showToast(error.message || 'Could not start research.'); if (button) { button.disabled = false; button.innerHTML = 'Investigate <span aria-hidden="true">→</span>'; } }
  }
  function showToast(message) { const old = document.querySelector('.toast'); old?.remove(); const el = document.createElement('div'); el.className = 'toast'; el.setAttribute('role', 'alert'); el.textContent = message; document.body.appendChild(el); setTimeout(() => el.remove(), 5000); }

  async function loadSession() {
    state.loading = true; renderResearch();
    try { const payload = await api(`/api/sessions/${encodeURIComponent(state.id)}`); state.data = payload || {}; state.loading = false; state.eventCursor = eventCursor(payload); renderResearch(); schedulePoll(); }
    catch (error) { state.loading = false; state.error = error.status === 404 ? 'This research session could not be found.' : (error.message || 'The research service is unavailable.'); renderResearch(); }
  }
  function eventCursor(data) { const events = dataArray(data, 'events'); const last = events[events.length - 1]; return Number(text(obj(last).cursor, obj(last).sequence, obj(last).seq, -1)); }
  function isFinished() { return ['complete', 'completed', 'done', 'failed', 'error', 'paused'].includes(sessionStatus(state.data)); }
  function schedulePoll() { if (state.pollTimer || !state.id || !state.data || isFinished()) return; state.pollTimer = setTimeout(async () => { state.pollTimer = null; await pollSession(); }, 3500); }
  async function pollSession() {
    if (!state.id) return;
    try {
      const [payload, eventPayload] = await Promise.all([api(`/api/sessions/${encodeURIComponent(state.id)}`), api(`/api/sessions/${encodeURIComponent(state.id)}/events?after=${encodeURIComponent(state.eventCursor)}`).catch(() => null)]);
      state.data = payload || {}; if (eventPayload) { const events = arr(eventPayload.events || eventPayload); const last = events[events.length - 1]; state.eventCursor = Math.max(state.eventCursor, Number(text(obj(last).sequence, obj(last).seq, 0)) || 0); }
      state.error = ''; renderResearch();
    } catch (error) { state.error = `Live connection interrupted — retrying${error.message ? `: ${error.message}` : ''}.`; renderResearch(); }
    schedulePoll();
  }

  function progressValue(data) { const p = obj(data).progress; const n = Number(text(p.value, p.percent, p.progress, obj(data).session?.progress, 0)); return Math.max(0, Math.min(100, n <= 1 && n > 0 ? n * 100 : n)); }
  function statusLabel(status) { return status.replace(/[_-]/g, ' ').replace(/\b\w/g, c => c.toUpperCase()); }
  function countDisputed() { return claims().filter(c => /disput|contrad|contested|uncertain/i.test(String(text(obj(c).status, obj(c).state, obj(c).verdict)))).length; }
  function countIndependent() { const groups = new Set(sources().map(s => text(s.lineageGroupId, s.id)).filter(Boolean)); return groups.size; }
  function renderResearch() {
    if (state.loading && !state.data) { app.innerHTML = `<div class="loading-screen"><span class="spinner"></span> Connecting to the research session…</div>`; return; }
    if (state.error && !state.data) { app.innerHTML = `<main class="error-page"><a class="brand" href="#/"><span class="brand-mark">CL</span> ClaimLens</a><div class="error-card"><span class="eyebrow">SESSION ERROR</span><h1>${esc(state.error)}</h1><p>The session may still be starting, or the link may have expired.</p><a class="button button-primary" href="#/">Start a new investigation</a></div></main>`; return; }
    const d = state.data || {}; const cs = claims(), ss = sources(); const p = progressValue(d); const status = sessionStatus(d); const reportAvailable = Boolean(obj(d).report || ['complete', 'completed', 'done'].includes(status));
    app.innerHTML = `<main class="workspace"><header class="topbar"><a class="brand" href="#/" aria-label="ClaimLens home"><span class="brand-mark">CL</span><span>ClaimLens</span></a><div class="top-question" title="${esc(sessionQuestion(d))}">${esc(sessionQuestion(d))}</div><div class="top-actions">${reportAvailable ? `<button class="button button-quiet ${state.reportOpen ? 'active' : ''}" data-action="report">${state.reportOpen ? 'Research graph' : 'View report'}</button>` : ''}<a class="back-link" href="#/">New question <span aria-hidden="true">+</span></a></div></header>
    ${state.error ? `<div class="connection-banner" role="status"><span class="status-dot amber"></span>${esc(state.error)}</div>` : ''}
    <section class="session-head"><div><div class="eyebrow">LIVE INVESTIGATION <span class="live-pip"></span></div><h1>${esc(sessionQuestion(d))}</h1></div><div class="session-state"><span class="status-chip ${esc(status)}">${esc(statusLabel(status))}</span><span class="stage">${esc(text(obj(d).progress?.phase, obj(d).progress?.stage, obj(d).stage, isFinished() ? 'Review ready' : 'Gathering evidence'))}</span></div></section>
    <div class="progress-row"><div class="progress-track"><span style="width:${p}%"></span></div><strong>${Math.round(p)}%</strong><span class="progress-note">${esc(text(obj(d).progress?.message, obj(d).progress?.detail, 'Evidence is being assembled'))}</span></div>
    <div class="count-strip"><span><b>${ss.length}</b> sources</span><span><b>${cs.length}</b> claims</span><span class="coral"><b>${countDisputed()}</b> disputed</span><span class="mint"><b>${countIndependent()}</b> independent</span></div>
    ${state.reportOpen ? reportView(d) : `<div class="research-grid"><aside class="activity-panel panel"><div class="panel-heading"><div><span class="section-kicker">TRACE</span><h2>Live activity</h2></div><span class="pulse-label">${isFinished() ? 'ARCHIVED' : 'LIVE'}</span></div>${activityView(d)}</aside><section class="graph-panel panel"><div class="panel-heading"><div><span class="section-kicker">EVIDENCE MAP</span><h2>Argument graph</h2></div><div class="graph-tools"><button class="icon-button" data-action="zoom-out" aria-label="Zoom out">−</button><button class="icon-button" data-action="zoom-in" aria-label="Zoom in">+</button><button class="text-button" data-action="fit">Fit</button><label class="filter"><input type="checkbox" data-action="disputed" ${state.disputedOnly ? 'checked' : ''}> disputed</label></div></div>${graphView(d)}</section><aside class="inspector-panel panel" aria-live="polite">${inspectorView(d)}</aside></div>`}
    </main>`;
    bindResearchEvents();
  }

  function activityView(d) {
    const events = dataArray(d, 'events'); if (!events.length) return `<div class="empty-state"><span class="empty-icon">◌</span><p>Waiting for the first researcher signal.</p><small>New activity will appear here as the session progresses.</small></div>`;
    const groups = new Map(); events.forEach(e => { const role = String(text(obj(e).role, obj(e).agent, obj(e).actor, obj(e).payload?.role, 'researcher')).toLowerCase(); const key = roles.find(r => role.includes(r[0]))?.[1] || (role === 'follow-up' ? 'Follow-up' : statusLabel(role)); if (!groups.has(key)) groups.set(key, []); groups.get(key).push(e); });
    return `<div class="timeline">${Array.from(groups).map(([group, rows]) => `<section class="timeline-group"><h3><span class="role-icon ${esc(group.toLowerCase().replace(/[^a-z]+/g, '-'))}"></span>${esc(group)} <span>${rows.length}</span></h3>${rows.slice(-12).map(e => `<article class="event"><span class="event-line"></span><div><p>${esc(text(obj(e).message, obj(e).payload?.message, obj(e).payload?.detail, obj(e).payload?.query, obj(e).type, 'Activity recorded'))}</p><time>${esc(formatDate(text(obj(e).timestamp, obj(e).createdAt, obj(e).at)))}</time></div></article>`).join('')}</section>`).join('')}</div>`;
  }

  function graphModel(d) {
    const graph = obj(d).graph; let nodes = arr(graph.nodes); let edges = arr(graph.edges || graph.links);
    if (!nodes.length) nodes = [...claims().map(c => ({ ...c, id: idOf(c), type: 'CLAIM', label: labelOf(c, idOf(c)) })), ...sources().map(s => ({ ...s, id: idOf(s), type: 'SOURCE', label: labelOf(s, idOf(s)) }))];
    const qid = text(obj(d).session?.id, d.sessionId, state.id) || 'question';
    if (nodes.length && !nodes.some(n => /question|session/i.test(String(text(obj(n).type, obj(n).kind)))) ) nodes.unshift({ id: qid, type: 'QUESTION', label: sessionQuestion(d) });
    nodes = nodes.map((n, i) => { const entity = obj(obj(n).entity); const rawType = String(text(obj(n).type, obj(n).kind, obj(n).entityType, entity.type, 'CLAIM')).toUpperCase(); const type = rawType === 'SESSION' ? 'QUESTION' : rawType; return { ...entity, ...obj(n), id: idOf(n) || `node-${i}`, type, label: labelOf(n, idOf(n)) }; });
    const nodeIds = new Set(nodes.map(n => n.id));
    edges = edges.map((e, i) => ({ ...obj(e), id: idOf(e) || `edge-${i}`, source: String(text(obj(e).source, obj(e).from, obj(e).sourceId)), target: String(text(obj(e).target, obj(e).to, obj(e).targetId)), type: String(text(obj(e).type, obj(e).relationship, 'SUPPORTS')).toUpperCase() })).filter(e => nodeIds.has(e.source) && nodeIds.has(e.target));
    const cols = { QUESTION: 1, CLAIM: 2, SOURCE: 3 }; nodes.forEach((n, i) => { n.x = Number(n.x) || cols[n.type] * 290 || 260; n.y = Number(n.y) || 90 + (i % 7) *  ninety(); });
    return { nodes, edges };
  }
  function ninety() { return 92; }
  function graphView(d) {
    const model = graphModel(d); const visible = state.disputedOnly ? model.nodes.filter(n => n.type !== 'CLAIM' || /disput|contrad|contested|uncertain/i.test(String(text(n.status, n.state, n.verdict)))) : model.nodes; const visibleIds = new Set(visible.map(n => n.id)); const edges = model.edges.filter(e => visibleIds.has(e.source) && visibleIds.has(e.target));
    if (!visible.length) return `<div class="graph-empty"><span class="empty-icon">◎</span><h3>${model.nodes.length ? 'No disputed claims' : 'The map is still empty'}</h3><p>${model.nodes.length ? 'Turn off the filter to see the full argument.' : 'Nodes and relationships will draw here as evidence arrives.'}</p></div>`;
    const maxX = Math.max(1000, ...visible.map(n => n.x + 230)), maxY = Math.max(620, ...visible.map(n => n.y + 100)); const width = maxX, height = maxY; const byId = new Map(model.nodes.map(n => [n.id, n]));
    const edgeMarkup = edges.map(e => { const a = byId.get(e.source), b = byId.get(e.target); return `<g class="edge edge-${esc(e.type.toLowerCase())}"><line x1="${a.x + 108}" y1="${a.y + 36}" x2="${b.x + 108}" y2="${b.y + 36}" marker-end="url(#arrow-${esc(e.type.toLowerCase())})"></line><text x="${(a.x + b.x) / 2 + 108}" y="${(a.y + b.y) / 2 + 27}">${esc(e.type.replace(/_/g, ' '))}</text></g>`; }).join('');
    const nodeMarkup = visible.map(n => `<g class="graph-node node-${esc(n.type.toLowerCase())} ${state.selected?.id === n.id ? 'selected' : ''}" tabindex="0" role="button" aria-label="${esc(`${n.type}: ${n.label}`)}" data-node="${esc(n.id)}" transform="translate(${n.x},${n.y})"><rect width="216" height="72" rx="8"></rect><text class="node-type" x="14" y="20">${esc(n.type)}</text><text class="node-label" x="14" y="43">${esc(n.label.slice(0, 29))}${n.label.length > 29 ? '…' : ''}</text><text class="node-meta" x="14" y="61">${esc(nodeMeta(n))}</text></g>`).join('');
    return `<div class="graph-wrap"><svg class="graph" viewBox="0 0 ${width} ${height}" style="--graph-zoom:${state.graphZoom}" aria-label="Interactive evidence graph"><defs>${['supports','contradicts','qualifies','derived_from','cites','asks'].map(k => `<marker id="arrow-${k}" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto"><path d="M0,0 L0,6 L7,3 z"></path></marker>`).join('')}</defs><g class="graph-content" transform="scale(${state.graphZoom})">${edgeMarkup}${nodeMarkup}</g></svg><div class="graph-legend"><span><i class="legend-question"></i>Question</span><span><i class="legend-claim"></i>Claim</span><span><i class="legend-source"></i>Source</span><span class="legend-edge"><i class="edge-swatch support"></i>Supports</span><span class="legend-edge"><i class="edge-swatch contradict"></i>Contradicts</span></div><div class="graph-accessible"><h3>Graph list</h3>${visible.map(n => `<button data-node="${esc(n.id)}"><b>${esc(n.type)}</b> ${esc(n.label)}</button>`).join('')}</div></div>`;
  }
  function nodeMeta(n) { return text(n.status, n.domain, n.publisher, n.type === 'SOURCE' ? 'Evidence source' : 'Click to inspect'); }

  function bindResearchEvents() {
    app.querySelectorAll('[data-node]').forEach(el => { el.addEventListener('click', () => selectNode(el.dataset.node)); el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectNode(el.dataset.node); } }); });
    app.querySelector('[data-action="zoom-in"]')?.addEventListener('click', () => { state.graphZoom = Math.min(1.5, state.graphZoom + .1); renderResearch(); });
    app.querySelector('[data-action="zoom-out"]')?.addEventListener('click', () => { state.graphZoom = Math.max(.55, state.graphZoom - .1); renderResearch(); });
    app.querySelector('[data-action="fit"]')?.addEventListener('click', () => { state.graphZoom = 1; renderResearch(); });
    app.querySelector('[data-action="disputed"]')?.addEventListener('change', e => { state.disputedOnly = e.target.checked; renderResearch(); });
    app.querySelector('[data-action="report"]')?.addEventListener('click', () => { state.reportOpen = !state.reportOpen; renderResearch(); });
  }
  function selectNode(id) { const model = graphModel(state.data || {}); const n = model.nodes.find(x => x.id === id); if (n) { state.selected = n; renderResearch(); } }
  function inspectorView(d) {
    if (!state.selected) return `<div class="inspector-empty"><span class="inspect-cross">＋</span><span class="section-kicker">INSPECTOR</span><h2>Select a node</h2><p>Click a claim or source in the map to examine its evidence, provenance, and relationships.</p></div>`;
    const n = state.selected; const claim = n.type === 'CLAIM' ? claims().find(c => idOf(c) === n.id) || n : null; const source = n.type === 'SOURCE' ? sources().find(s => idOf(s) === n.id) || n : null;
    return claim ? claimInspector(claim, d) : source ? sourceInspector(source, d) : `<div class="inspector-empty"><span class="section-kicker">QUESTION</span><h2>${esc(labelOf(n, sessionQuestion(d)))}</h2><p>The investigation question anchors this evidence map.</p></div>`;
  }
  function relationSources(claim, kind, d) {
    const wanted = kind.toLowerCase(); const keys = wanted === 'supporting' ? ['supportingSources', 'supports', 'supporting'] : wanted === 'contradicting' ? ['contradictingSources', 'contradicts', 'contradicting'] : ['qualifyingSources', 'qualifies', 'qualifying'];
    for (const key of keys) if (Array.isArray(obj(claim)[key])) return obj(claim)[key];
    const types = wanted === 'supporting' ? ['SUPPORTS'] : wanted === 'contradicting' ? ['CONTRADICTS'] : ['QUALIFIES'];
    return arr(obj(d).evidenceEdges).filter(edge => edge.claimId === claim.id && types.includes(String(edge.type).toUpperCase())).map(edge => sources().find(source => source.id === edge.sourceId) || edge.sourceId).filter(Boolean);
  }
  function sourceList(items, empty) { return items.length ? `<ul class="source-list">${items.map(item => { const s = typeof item === 'object' ? item : sources().find(x => idOf(x) === String(item)) || { id: item, title: item }; return `<li><button data-node="${esc(idOf(s))}"><span class="source-bullet"></span><span>${esc(labelOf(s, idOf(s)))}</span></button></li>`; }).join('')}</ul>` : `<p class="muted">${esc(empty)}</p>`; }
  function factorRows(claim) { const factors = obj(claim).evidenceStrengthFactors || obj(claim).factors || obj(claim).evidenceFactors; if (!factors) return `<p class="muted">No factor breakdown was provided.</p>`; if (Array.isArray(factors)) return factors.map(f => `<li><span>${esc(labelOf(f, text(obj(f).factor, 'Factor')))}</span><b>${esc(text(obj(f).value, obj(f).score, '—'))}</b></li>`).join(''); return Object.entries(factors).map(([k, v]) => `<li><span>${esc(k)}</span><b>${esc(v)}</b></li>`).join(''); }
  function claimInspector(c, d) {
    const status = text(c.status, c.state, c.verdict, 'unresolved'); const strength = text(c.evidenceStrength, c.strength, c.score, 'Not scored'); const allRelated = arr(obj(c).sources).length ? obj(c).sources : [];
    const supporting = relationSources(c, 'supporting', d); const contradicting = relationSources(c, 'contradicting', d); const qualifying = relationSources(c, 'qualifying', d); const rationale = text(c.whyResearching, c.why, c.researchRationale, obj(d).report?.whyResearchContinued, 'The skeptic stage reviewed this claim before the final adjudication.');
    return `<div class="inspector-head"><span class="section-kicker">CLAIM</span><span class="close-inspect" aria-hidden="true">×</span><h2>${esc(labelOf(c, idOf(c)))}</h2><span class="status-chip ${esc(String(status).toLowerCase())}">${esc(statusLabel(String(status)))}</span></div><div class="inspect-section strength"><div class="inspect-label">EVIDENCE STRENGTH</div><strong>${esc(strength)}${strength !== 'Not scored' ? '/100' : ''}</strong>${obj(c).confidence != null ? `<span class="confidence">${esc(c.confidence)} confidence</span>` : ''}</div><div class="inspect-section"><h3>Transparent factors</h3><ul class="factor-list">${factorRows(c)}</ul></div><div class="inspect-section"><h3>Supporting sources</h3>${sourceList(supporting.length ? supporting : allRelated, 'No supporting sources recorded.')}</div><div class="inspect-section"><h3>Contradicting sources</h3>${sourceList(contradicting, 'No contradicting sources recorded.')}</div><div class="inspect-section"><h3>Qualifying sources</h3>${sourceList(qualifying, 'No qualifying sources recorded.')}</div><div class="why-box"><span>WHY KEEP RESEARCHING?</span><p>${esc(rationale)}</p></div>`;
  }
  function sourceInspector(s, d) {
    const related = arr(obj(s).relatedClaims).length ? obj(s).relatedClaims : arr(obj(s).claims).length ? obj(s).claims : arr(obj(d).evidenceEdges).filter(edge => edge.sourceId === s.id).map(edge => claims().find(claim => claim.id === edge.claimId)).filter(Boolean); const rels = arr(obj(d).sourceRelationships).filter(r => idOf(obj(r).source) === idOf(s) || String(text(obj(r).sourceId, obj(r).from)) === idOf(s));
    return `<div class="inspector-head"><span class="section-kicker">SOURCE</span><span class="close-inspect" aria-hidden="true">×</span><h2>${esc(labelOf(s, idOf(s)))}</h2><span class="source-domain">${esc(text(s.publisher, s.domain, s.sourceType, 'Unclassified source'))}</span></div><div class="source-facts"><div><span>QUALITY</span><b>${esc(text(s.quality, s.qualityScore, s.reliability, 'Not rated'))}</b></div><div><span>RETRIEVAL ROLE</span><b>${esc(text(s.retrievalRole, s.searchRole, s.role, Array.isArray(s.retrievedBy) ? s.retrievedBy.join(', ') : '', s.purpose, 'Not specified'))}</b></div></div><div class="inspect-section"><h3>Excerpt</h3><blockquote>${esc(text(s.excerpt, s.snippet, s.quote, s.content, 'No excerpt was provided.'))}</blockquote></div><div class="inspect-section"><h3>Source metadata</h3><dl class="metadata"><div><dt>Published</dt><dd>${esc(text(s.publishedAt, s.publicationDate, 'Not recorded'))}</dd></div><div><dt>Retrieved</dt><dd>${esc(text(s.retrievedAt, s.accessedAt, 'Not recorded'))}</dd></div><div><dt>URL</dt><dd>${s.url || s.href ? `<a href="${esc(safeUrl(text(s.url, s.href)))}" target="_blank" rel="noopener noreferrer">Open source ↗</a>` : 'Not provided'}</dd></div></dl></div><div class="inspect-section"><h3>Related claims</h3>${sourceList(related, 'No related claims recorded.')}</div><div class="inspect-section"><h3>Lineage</h3><p class="muted">${esc(text(s.lineage, s.provenance, s.lineageGroupId ? `Lineage group ${s.lineageGroupId.slice(0, 8)}` : '', 'No lineage details recorded.'))}</p></div><div class="inspect-section"><h3>Source relationships</h3>${rels.length ? `<ul class="relationship-list">${rels.map(r => { const target = sources().find(source => source.id === r.targetSourceId); return `<li><b>${esc(text(r.type, r.relationship, 'RELATED'))}</b> ${esc(text(r.targetTitle, r.target, r.to, target?.title, r.targetSourceId, r.description, 'Relationship recorded'))}</li>`; }).join('')}</ul>` : '<p class="muted">No source relationships recorded.</p>'}</div>`;
  }

  function reportView(d) {
    const report = obj(d).report; if (!report || !Object.keys(report).length) return `<section class="report-view panel"><div class="report-empty"><span class="section-kicker">REPORT</span><h2>Report not ready</h2><p>The session is complete, but no report was returned by the backend.</p><button class="button button-quiet" data-action="report">Back to graph</button></div></section>`;
    const findings = arr(report.findings || report.keyFindings || report.conclusions); const limitations = arr(report.limitations || report.caveats); const citationLinks = item => arr(obj(item).citations).map(c => { const url = text(obj(c).url, obj(c).href); return url ? `<a class="source-link" href="${esc(safeUrl(url))}" target="_blank" rel="noopener noreferrer">[${esc(text(c.sourceId, 'source'))}]</a>` : ''; }).join(' '); const link = item => { const url = text(obj(item).url, obj(item).href); return url ? ` <a class="source-link" href="${esc(safeUrl(url))}" target="_blank" rel="noopener noreferrer">[source]</a>` : citationLinks(item); };
    const list = (items, fallback) => items.length ? `<ul class="report-list">${items.map(x => `<li>${esc(typeof x === 'object' ? text(x.text, x.finding, x.claim, x.title) : x)}${typeof x === 'object' && x.status ? ` <span class="report-status">${esc(statusLabel(x.status))} · ${esc(text(x.evidenceStrength, '—'))}/100</span>` : ''}${link(x)}</li>`).join('')}</ul>` : `<p class="muted">${esc(fallback)}</p>`;
    const sourceItems = arr(report.sources).slice(0, 12).map(source => `<li><a class="source-link" href="${esc(safeUrl(source.url))}" target="_blank" rel="noopener noreferrer">[${esc(source.id)}]</a> ${esc(text(source.title, source.publisher, source.url))}</li>`).join('');
    return `<section class="report-view panel"><div class="report-header"><div><span class="section-kicker">FINAL REPORT</span><h2>${esc(text(report.title, 'Executive report'))}</h2><p>${esc(text(report.subtitle, report.generatedAt ? `Generated ${formatDate(report.generatedAt)}` : 'Evidence-backed synthesis'))}</p></div><button class="button button-quiet" data-action="report">Back to graph</button></div><article class="conclusion"><span class="section-kicker">EXECUTIVE CONCLUSION</span><p>${esc(text(report.executiveConclusion, report.conclusion, report.summary, 'No executive conclusion was provided.'))}</p></article><div class="report-columns"><section><h3>Findings</h3>${list(findings, 'No findings were provided.')}</section><section><h3>Limitations</h3>${list(limitations, 'No limitations were provided.')}</section></div><section class="report-sources"><h3>Sources</h3>${sourceItems ? `<ul class="report-list">${sourceItems}</ul>` : '<p class="muted">No source bibliography was returned.</p>'}</section></section>`;
  }

  window.addEventListener('hashchange', onHash); onHash(); checkDemo();
})();

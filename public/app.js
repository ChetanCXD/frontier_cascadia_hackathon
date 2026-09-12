/* ClaimLens is intentionally dependency-free: the API is the source of truth. */
(() => {
  'use strict';

  const app = document.getElementById('app');
  const state = {
    route: 'landing', id: null, data: null, loading: false, error: '', selected: null,
    reportOpen: false, demo: { checked: false, available: false, payload: null },
    eventCursor: 0, pollTimer: null, abort: null, requestGeneration: 0, graphZoom: 1, graphPan: { x: 0, y: 0 }, disputedOnly: false
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
    if (state.pollTimer) { clearTimeout(state.pollTimer); state.pollTimer = null; }
    state.abort?.abort(); state.abort = null; state.requestGeneration += 1;
    state.route = next.route; state.id = next.id; state.data = null; state.error = ''; state.selected = null; state.eventCursor = 0; state.reportOpen = false; state.graphZoom = 1; state.graphPan = { x: 0, y: 0 };
    if (next.route === 'research') loadSession(state.requestGeneration, next.id); else renderLanding();
  }

  async function checkDemo() {
    try { const payload = await api('/api/demo'); state.demo = { checked: true, available: Boolean(payload && (payload.sessionId || payload.session || payload.id)), payload }; }
    catch (error) { state.demo = { checked: true, available: error.status !== 404 ? false : false, payload: null }; }
    if (state.route === 'landing') {
      const slot = app.querySelector('.demo-slot');
      if (slot) {
        slot.innerHTML = state.demo.available ? '<button class="button button-quiet" data-action="demo">Open saved demo <span aria-hidden="true">↗</span></button>' : `<p class="honest-state"><span class="status-dot"></span>${state.demo.checked ? 'No saved demo is available yet.' : 'Checking whether a real saved demo exists…'}</p>`;
        slot.querySelector('[data-action="demo"]')?.addEventListener('click', () => openDemo());
      } else renderLanding();
    }
  }
  function renderLanding() {
    const demo = state.demo.available ? `<button class="button button-quiet" data-action="demo">Open saved demo <span aria-hidden="true">↗</span></button>` : `<p class="honest-state"><span class="status-dot"></span>${state.demo.checked ? 'No saved demo is available yet.' : 'Checking whether a real saved demo exists…'}</p>`;
    app.innerHTML = `<main class="landing">
      <nav class="landing-nav"><a class="brand" href="#/" aria-label="ClaimLens home"><span class="brand-mark">CL</span><span>ClaimLens</span></a><span class="nav-note">Evidence debugger</span></nav>
      <section class="hero" aria-labelledby="hero-title"><div class="eyebrow">RESEARCH WITH RECEIPTS</div><h1 id="hero-title">Research that tries to<br><em>prove itself wrong.</em></h1><p class="hero-copy">ClaimLens makes the argument visible: who looked, what they found, where sources disagree, and why the agent kept researching.</p>
      <form id="question-form" class="question-form" novalidate><label for="question">What should we investigate?</label><div class="input-wrap"><textarea id="question" name="question" rows="2" required minlength="8" maxlength="2000" aria-describedby="question-error question-status" aria-invalid="false" placeholder="e.g. Does remote work improve long-term productivity?"></textarea><button class="button button-primary" type="submit">Investigate <span aria-hidden="true">→</span></button></div><p id="question-error" class="form-error" role="alert" aria-live="assertive" hidden></p><p id="question-status" class="form-status" role="status" aria-live="polite"></p><div class="form-meta"><button class="example" type="button" data-action="example">Try an example</button><span>Every conclusion stays linked to its evidence.</span></div></form>
      <div class="landing-foot"><div><span class="section-kicker">WORKSPACE</span><h2>Not a chat transcript.</h2><p>Follow claims through support, contradiction, qualification, and provenance in one research workspace.</p></div><div class="demo-slot">${demo}</div></div>
      <section class="product-story" aria-labelledby="story-title"><div class="story-copy"><span class="section-kicker">ANSWERS ARE ONLY THE BEGINNING</span><h2 id="story-title">See the evidence.<br>Not just the answer.</h2><p>ClaimLens researches your question, looks for counterevidence, and connects claims to their sources in an interactive map.</p><p>Instead of stopping at a chat-style summary, inspect disagreements, trace shared source origins, and explore why each claim earned its assessment.</p><div class="story-tags"><span>Source-linked claims</span><span>Separate skeptic review</span><span>Inspectable provenance</span></div></div><div class="evidence-art" aria-hidden="true"><div class="art-caption">FROM QUESTION TO CLARITY <span>ILLUSTRATION</span></div><svg viewBox="0 0 400 260" fill="none"><path class="art-line" d="M200 50 C200 100 80 80 80 140 M200 50 V140 M200 50 C200 100 320 80 320 140 M80 140 C80 210 200 180 200 230 M200 140 V230 M320 140 C320 210 200 180 200 230"/><circle class="art-halo" cx="200" cy="50" r="32"/><rect x="160" y="28" width="80" height="44" rx="14" fill="#204f44"/><path d="M188 49h24m-18 8h12" stroke="white" stroke-width="3" stroke-linecap="round"/><g class="art-card"><rect x="32" y="116" width="96" height="48" rx="12"/><circle cx="52" cy="140" r="5" fill="#478b70"/><path d="M66 136h44m-44 9h30"/></g><g class="art-card art-card-two"><rect x="152" y="116" width="96" height="48" rx="12"/><circle cx="172" cy="140" r="5" fill="#bd8650"/><path d="M186 136h44m-44 9h30"/></g><g class="art-card art-card-three"><rect x="272" y="116" width="96" height="48" rx="12"/><circle cx="292" cy="140" r="5" fill="#6b8eb6"/><path d="M306 136h44m-44 9h30"/></g><circle cx="200" cy="230" r="17" fill="#e3efe7" stroke="#b3cdbb"/><path d="m193 230 5 5 9-10" stroke="#39745b" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg><div class="art-foot"><span class="art-dot"></span>One question. Multiple perspectives.</div></div></section></section>
    </main>`;
    document.getElementById('question-form')?.addEventListener('submit', createSession);
    const questionInput = document.getElementById('question');
    const resizeQuestion = () => { questionInput.style.height = 'auto'; questionInput.style.height = questionInput.scrollHeight + 'px'; };
    questionInput.addEventListener('input', resizeQuestion); resizeQuestion();
    app.querySelector('[data-action="example"]')?.addEventListener('click', () => { const q = document.getElementById('question'); q.value = 'Does remote work improve long-term productivity?'; q.dispatchEvent(new Event('input')); q.setAttribute('aria-invalid', 'false'); setFormFeedback('', 'Example loaded. Edit it or investigate this question.'); q.focus(); });
    app.querySelector('[data-action="demo"]')?.addEventListener('click', () => openDemo());
  }
  async function openDemo() {
    try { const payload = state.demo.payload || await api('/api/demo'); const id = text(payload.sessionId, payload.session?.id, payload.id); if (id) navigate(`#/research/${encodeURIComponent(id)}`); else showToast('The saved demo has no session id.'); }
    catch (_) { showToast('The saved demo could not be opened.'); }
  }
  function setFormFeedback(errorMessage = '', statusMessage = '') {
    const error = document.getElementById('question-error'); const status = document.getElementById('question-status');
    if (error) { error.hidden = !errorMessage; error.textContent = errorMessage; }
    if (status) status.textContent = statusMessage;
  }
  function sessionPayload(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !payload.session || typeof payload.session !== 'object') throw new Error('The research service returned an invalid session response.');
    return payload;
  }
  async function createSession(event) {
    event.preventDefault();
    const form = event.target; const button = form.querySelector('button[type="submit"]'); const input = document.getElementById('question');
    if (button?.disabled) return;
    const q = input?.value.trim() || '';
    if (q.length < 8 || q.length > 2000) { const message = q ? 'Your question must be between 8 and 2,000 characters.' : 'Enter a research question before investigating.'; input?.setAttribute('aria-invalid', 'true'); setFormFeedback(message, ''); input?.focus(); return; }
    input?.setAttribute('aria-invalid', 'false'); setFormFeedback('', 'Creating a research session…'); if (button) { button.disabled = true; button.textContent = 'Starting…'; }
    try { const payload = sessionPayload(await api('/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: q }) })); const id = text(payload.sessionId, payload.session?.id, payload.id, obj(payload.data).sessionId); if (!id) throw new Error('The research service returned no session id.'); navigate(`#/research/${encodeURIComponent(id)}`); }
    catch (error) { const message = error.message || 'Could not start research.'; setFormFeedback(message, 'The session could not be started. Try again.'); showToast(message); if (button) { button.disabled = false; button.innerHTML = 'Investigate <span aria-hidden="true">→</span>'; } }
  }
  function showToast(message) { const old = document.querySelector('.toast'); old?.remove(); const el = document.createElement('div'); el.className = 'toast'; el.setAttribute('role', 'alert'); el.textContent = message; document.body.appendChild(el); setTimeout(() => el.remove(), 5000); }

  function isCurrentRequest(generation, id) { return generation === state.requestGeneration && id === state.id; }
  function isAbort(error) { return error?.name === 'AbortError'; }
  async function loadSession(generation = state.requestGeneration, id = state.id) {
    state.loading = true; renderResearch(); const controller = new AbortController(); state.abort = controller;
    try { const payload = sessionPayload(await api(`/api/sessions/${encodeURIComponent(id)}`, { signal: controller.signal })); if (!isCurrentRequest(generation, id)) return; state.data = payload; state.loading = false; state.abort = null; state.eventCursor = eventCursor(payload); renderResearch(); schedulePoll(); }
    catch (error) { if (!isCurrentRequest(generation, id) || isAbort(error)) return; state.loading = false; state.abort = null; state.error = error.status === 404 ? 'This research session could not be found.' : (error.message || 'The research service returned an invalid session.'); state.data = null; renderResearch(); }
  }
  function eventCursor(data) { const events = dataArray(data, 'events'); const last = events[events.length - 1]; const value = Number(text(obj(last).cursor, obj(last).sequence, obj(last).seq, -1)); return Number.isFinite(value) ? value : -1; }
  function isFinished() { return ['complete', 'completed', 'done', 'failed', 'error', 'paused'].includes(sessionStatus(state.data)); }
  function schedulePoll() { if (state.pollTimer || !state.id || !state.data || isFinished()) return; const generation = state.requestGeneration; const id = state.id; state.pollTimer = setTimeout(async () => { state.pollTimer = null; await pollSession(generation, id); }, 3500); }
  async function pollSession(generation = state.requestGeneration, id = state.id) {
    if (!isCurrentRequest(generation, id)) return;
    const controller = new AbortController(); state.abort?.abort(); state.abort = controller;
    try {
      const [payload, eventPayload] = await Promise.all([sessionPayload(await api(`/api/sessions/${encodeURIComponent(id)}`, { signal: controller.signal })), api(`/api/sessions/${encodeURIComponent(id)}/events?after=${encodeURIComponent(state.eventCursor)}`, { signal: controller.signal }).catch(() => null)]);
      if (!isCurrentRequest(generation, id)) return; state.abort = null; state.data = payload; if (eventPayload) { const events = arr(eventPayload.events || eventPayload); const last = events[events.length - 1]; const nextCursor = Number(eventPayload.nextCursor); const lastCursor = Number(obj(last).cursor ?? obj(last).sequence ?? obj(last).seq); state.eventCursor = Math.max(state.eventCursor, Number.isFinite(nextCursor) ? nextCursor : Number.isFinite(lastCursor) ? lastCursor : -1); }
      state.error = ''; renderResearch();
    } catch (error) { if (!isCurrentRequest(generation, id) || isAbort(error)) return; state.abort = null; if (error.status === 404 || error.status === 400) { state.data = null; state.error = error.status === 404 ? 'This research session could not be found.' : (error.message || 'This research session is invalid.'); renderResearch(); return; } state.error = `Live connection interrupted — retrying${error.message ? `: ${error.message}` : ''}.`; renderResearch(); }
    if (isCurrentRequest(generation, id)) schedulePoll();
  }

  function progressValue(data) { const p = obj(data).progress; const n = Number(text(p.value, p.percent, p.progress, obj(data).session?.progress, 0)); return Math.max(0, Math.min(100, n <= 1 && n > 0 ? n * 100 : n)); }
  function statusLabel(status) { return status.replace(/[_-]/g, ' ').replace(/\b\w/g, c => c.toUpperCase()); }
  function countDisputed() { return claims().filter(c => /disput|contrad|contested|uncertain|mixed/i.test(String(text(obj(c).status, obj(c).state, obj(c).verdict)))).length; }
  function countIndependent() { const groups = new Set(sources().map(s => text(s.lineageGroupId, s.id)).filter(Boolean)); return groups.size; }
  function renderResearch() {
    if (state.loading && !state.data) { app.innerHTML = `<div class="loading-screen"><span class="spinner"></span> Connecting to the research session…</div>`; return; }
    if (state.error && !state.data) { app.innerHTML = `<main class="error-page"><a class="brand" href="#/"><span class="brand-mark">CL</span> ClaimLens</a><div class="error-card"><span class="eyebrow">SESSION ERROR</span><h1>${esc(state.error)}</h1><p>The session may still be starting, or the link may have expired.</p><a class="button button-primary" href="#/">Start a new investigation</a></div></main>`; return; }
    const d = state.data || {}; const cs = claims(), ss = sources(); const p = progressValue(d); const status = sessionStatus(d); const finished = isFinished(); const savedDemo = Boolean(obj(d).session?.demo || obj(d).session?.metadata?.demo); const investigationLabel = savedDemo ? 'PREVIOUSLY COMPLETED RESEARCH' : finished ? 'INVESTIGATION ARCHIVE' : 'LIVE INVESTIGATION'; const failureText = text(obj(d).session?.error, obj(d).session?.failureReason, obj(d).errors?.[0]?.message, obj(d).errors?.[0]); const reportAvailable = Boolean(obj(d).report || ['complete', 'completed', 'done'].includes(status));
    app.innerHTML = `<main class="workspace"><header class="topbar"><a class="brand" href="#/" aria-label="ClaimLens home"><span class="brand-mark">CL</span><span>ClaimLens</span></a><div class="top-question" title="${esc(sessionQuestion(d))}">${esc(sessionQuestion(d))}</div><div class="top-actions"><a class="back-link" href="#/">New question <span aria-hidden="true">+</span></a></div></header>
    ${state.error ? `<div class="connection-banner" role="status"><span class="status-dot amber"></span>${esc(state.error)}</div>` : ''}
    ${failureText && (status === 'failed' || status === 'error' || status === 'paused') ? `<div class="failure-banner ${esc(status)}" role="${status === 'failed' || status === 'error' ? 'alert' : 'status'}"><strong>${status === 'paused' ? 'Research paused' : 'Research failed'}</strong><span>${esc(failureText)}</span></div>` : ''}
    <section class="session-head"><div><div class="eyebrow">${esc(investigationLabel)} ${!savedDemo && !finished ? '<span class="live-pip"></span>' : ''}</div><h1>${esc(sessionQuestion(d))}</h1></div><div class="session-state"><span class="status-chip ${esc(status)}">${esc(statusLabel(status))}</span><span class="stage">${esc(text(obj(d).progress?.phase, obj(d).progress?.stage, obj(d).stage, isFinished() ? 'Review ready' : 'Gathering evidence'))}</span></div></section>
    <div class="progress-row"><div class="progress-track"><span style="width:${p}%"></span></div><strong>${Math.round(p)}%</strong><span class="progress-note">${esc(text(obj(d).progress?.message, obj(d).progress?.detail, 'Evidence is being assembled'))}</span></div>
    <div class="count-strip"><span><b>${ss.length}</b> sources</span><span><b>${cs.length}</b> claims</span><span class="coral"><b>${countDisputed()}</b> disputed</span><span class="mint"><b>${countIndependent()}</b> independent</span>${reportAvailable && !state.reportOpen ? '<button class="button button-quiet workspace-report" data-action="report">View report <span aria-hidden="true">↗</span></button>' : ''}</div>
    ${state.reportOpen ? reportView(d) : `<div class="research-grid"><aside class="activity-panel panel"><div class="panel-heading"><div><span class="section-kicker">TRACE</span><h2>Live activity</h2></div><span class="pulse-label">${savedDemo ? 'SAVED DEMO' : finished ? 'ARCHIVED' : 'LIVE'}</span></div>${activityView(d)}</aside><section class="graph-panel panel"><div class="panel-heading"><div><span class="section-kicker">EVIDENCE MAP</span><h2>Argument graph</h2></div><div class="graph-tools"><button class="icon-button" data-action="zoom-out" aria-label="Zoom out">−</button><button class="icon-button" data-action="zoom-in" aria-label="Zoom in">+</button><button class="text-button" data-action="fit">Fit</button><label class="filter"><input type="checkbox" data-action="disputed" ${state.disputedOnly ? 'checked' : ''}> disputed</label></div></div>${graphView(d)}</section><aside class="inspector-panel panel" aria-live="polite">${inspectorView(d)}</aside></div>`}
    </main>`;
    bindResearchEvents();
  }

  function activityView(d) {
    const events = dataArray(d, 'events'); if (!events.length) return `<div class="empty-state"><span class="empty-icon">◌</span><p>Waiting for the first researcher signal.</p><small>New activity will appear here as the session progresses.</small></div>`;
    const groups = new Map(); events.forEach(e => { const role = String(text(obj(e).role, obj(e).agent, obj(e).actor, obj(e).payload?.role, 'researcher')).toLowerCase(); const key = roles.find(r => role.includes(r[0]))?.[1] || (role === 'follow-up' ? 'Follow-up' : statusLabel(role)); if (!groups.has(key)) groups.set(key, []); groups.get(key).push(e); });
    return `<div class="timeline">${Array.from(groups).map(([group, rows]) => `<section class="timeline-group"><h3><span class="role-icon ${esc(group.toLowerCase().replace(/[^a-z]+/g, '-'))}"></span>${esc(group)} <span>${rows.length}</span></h3>${rows.slice(-12).map(e => `<article class="event"><span class="event-line"></span><div><p>${esc(text(obj(e).message, obj(e).payload?.message, obj(e).payload?.error, Array.isArray(obj(e).payload?.errors) ? obj(e).payload.errors.join('; ') : '', obj(e).payload?.detail, obj(e).payload?.query, obj(e).type, 'Activity recorded'))}</p><time>${esc(formatDate(text(obj(e).timestamp, obj(e).createdAt, obj(e).at)))}</time></div></article>`).join('')}</section>`).join('')}</div>`;
  }

  function graphModel(d) {
    const compact = typeof window !== 'undefined' && window.innerWidth < 1100;
    const NODE_W = compact ? 180 : 220; const NODE_H = compact ? 74 : 84; const ROW = compact ? 92 : 102; const PAD_X = compact ? 20 : 28; const PAD_Y = compact ? 18 : 24;
    const allClaims = claims().map((claim, index) => ({ ...claim, id: idOf(claim) || `claim-${index}`, type: 'CLAIM', label: labelOf(claim, idOf(claim)) }));
    const allSources = sources().map((source, index) => ({ ...source, id: idOf(source) || `source-${index}`, type: 'SOURCE', label: labelOf(source, idOf(source)) }));
    const disputed = claim => /disput|contrad|contested|uncertain|mixed/i.test(String(text(claim.status, claim.state, claim.verdict)));
    const selectedClaims = state.disputedOnly ? allClaims.filter(disputed) : allClaims;
    const selectedClaimIds = new Set(selectedClaims.map(claim => claim.id));
    const rawEvidence = dataArray(d, 'evidenceEdges').map((edge, index) => ({ ...edge, id: idOf(edge) || `evidence-${index}`, source: String(text(edge.source, edge.from, edge.sourceId)), target: String(text(edge.target, edge.to, edge.claimId)), type: String(text(edge.type, edge.relationship, 'SUPPORTS')).toUpperCase(), family: 'evidence' }));
    const rawLineage = dataArray(d, 'sourceRelationships').map((edge, index) => ({ ...edge, id: idOf(edge) || `lineage-${index}`, source: String(text(edge.source, edge.from, edge.sourceId)), target: String(text(edge.target, edge.to, edge.targetSourceId)), type: String(text(edge.type, edge.relationship, 'POSSIBLY_SAME_ORIGIN')).toUpperCase(), family: 'lineage' }));
    const evidenceSources = new Set(rawEvidence.filter(edge => selectedClaimIds.has(edge.target)).map(edge => edge.source));
    const selectedSources = allSources.filter(source => !state.disputedOnly || evidenceSources.has(source.id));
    const qid = text(obj(d).session?.id, d.sessionId, state.id) || 'question';
    const nodes = [{ id: qid, type: 'QUESTION', label: sessionQuestion(d) }, ...selectedClaims, ...selectedSources];
    const claimX = PAD_X; const sourceX = compact ? 20 : 620; const sourceColumns = 2; const claimColumns = compact ? 2 : 1;
    const claimRows = Math.max(1, Math.ceil(selectedClaims.length / claimColumns)); const contentStart = compact ? 126 : 142; const sourceStart = compact ? contentStart + claimRows * ROW + 42 : contentStart;
    nodes[0].x = compact ? 150 : 420; nodes[0].y = PAD_Y;
    selectedClaims.forEach((claim, index) => { claim.x = compact ? claimX + (index % claimColumns) * 220 : claimX; claim.y = compact ? contentStart + Math.floor(index / claimColumns) * ROW : contentStart + index * ROW; });
    selectedSources.forEach((source, index) => { source.x = compact ? sourceX + (index % sourceColumns) * 220 : sourceX + (index % sourceColumns) * 252; source.y = sourceStart + Math.floor(index / sourceColumns) * ROW; });
    const nodeIds = new Set(nodes.map(node => node.id));
    const contextEdges = selectedClaims.map(claim => ({ id: `asks-${qid}-${claim.id}`, source: qid, target: claim.id, type: 'ASKS', family: 'context' }));
    const edges = [...contextEdges, ...rawEvidence, ...rawLineage].filter(edge => nodeIds.has(edge.source) && nodeIds.has(edge.target));
    const maxSourceX = selectedSources.length ? Math.max(...selectedSources.map(source => source.x)) : sourceX;
    const maxY = Math.max(nodes[0].y + NODE_H, ...nodes.slice(1).map(node => node.y + NODE_H), compact ? 460 : 560);
    return { nodes, edges, width: Math.max(compact ? 440 : 980, maxSourceX + NODE_W + (compact ? 40 : 90)), height: maxY + PAD_Y, nodeWidth: NODE_W, nodeHeight: NODE_H, row: ROW, compact };
  }
  function labelLines(value, limit = 30) {
    const words = String(value || '').trim().split(/\s+/).filter(Boolean); if (!words.length) return [''];
    const lines = []; let current = '';
    for (const word of words) { const candidate = current ? `${current} ${word}` : word; if (current && candidate.length > limit && lines.length < 1) { lines.push(current); current = word; } else current = candidate; }
    if (current) lines.push(current); return lines.slice(0, 2).map(line => line.length > limit + 2 ? `${line.slice(0, limit - 1)}…` : line);
  }
  function edgePath(edge, byId, model, index) {
    const a = byId.get(edge.source); const b = byId.get(edge.target); if (!a || !b) return '';
    if (edge.type === 'ASKS') { const sx = a.x + model.nodeWidth / 2; const sy = a.y + model.nodeHeight; const tx = b.x + model.nodeWidth / 2; const ty = b.y; return `M ${sx} ${sy} C ${sx} ${sy + 38}, ${tx} ${ty - 38}, ${tx} ${ty}`; }
    if (edge.family === 'lineage') { const sx = a.x + model.nodeWidth; const sy = a.y + model.nodeHeight / 2; const tx = b.x + model.nodeWidth; const ty = b.y + model.nodeHeight / 2; const lane = model.width - 28 - (index % 5) * 13; return `M ${sx} ${sy} C ${lane} ${sy}, ${lane} ${ty}, ${tx} ${ty}`; }
    const source = a.type === 'SOURCE' ? a : b; const claim = a.type === 'CLAIM' ? a : b; const sx = source.x; const sy = source.y + model.nodeHeight / 2; const tx = claim.x + model.nodeWidth; const ty = claim.y + model.nodeHeight / 2; const bend = (sx + tx) / 2 + ((index % 5) - 2) * 11; return `M ${sx} ${sy} C ${bend} ${sy}, ${bend} ${ty}, ${tx} ${ty}`;
  }
  function graphView(d) {
    const model = graphModel(d); const visibleIds = new Set(model.nodes.map(node => node.id)); const edges = model.edges.filter(edge => visibleIds.has(edge.source) && visibleIds.has(edge.target));
    if (model.nodes.length === 1 && !state.disputedOnly) return `<div class="graph-empty"><span class="empty-icon">◎</span><h3>The map is still empty</h3><p>Nodes and relationships will draw here as evidence arrives.</p></div>`;
    const byId = new Map(model.nodes.map(node => [node.id, node]));
    const edgeMarkup = edges.map((edge, index) => { const label = edge.type.replace(/_/g, ' '); const path = edgePath(edge, byId, model, index); return `<g class="edge edge-${esc(edge.type.toLowerCase())} edge-${esc(edge.family)}" tabindex="0" role="img" aria-label="${esc(label + ': ' + (byId.get(edge.source)?.label || edge.source) + ' → ' + (byId.get(edge.target)?.label || edge.target))}"><title>${esc(label + ': ' + (byId.get(edge.source)?.label || edge.source) + ' → ' + (byId.get(edge.target)?.label || edge.target))}</title><path d="${path}" marker-end="url(#arrow-${esc(edge.type.toLowerCase())})"></path><text class="edge-label" x="${(byId.get(edge.source).x + byId.get(edge.target).x) / 2 + model.nodeWidth / 2}" y="${(byId.get(edge.source).y + byId.get(edge.target).y) / 2 + model.nodeHeight / 2}">${esc(label)}</text></g>`; }).join('');
    const nodeMarkup = model.nodes.map(node => { const lines = labelLines(node.label, node.type === 'QUESTION' ? 34 : 29); const labelMarkup = lines.map((line, index) => '<tspan x="14" dy="' + (index ? 16 : 0) + '">' + esc(line) + '</tspan>').join(''); return '<g class="graph-node node-' + esc(node.type.toLowerCase()) + (state.selected?.id === node.id ? ' selected' : '') + '" tabindex="0" role="button" aria-label="' + esc(node.type + ': ' + node.label) + '" data-node="' + esc(node.id) + '" transform="translate(' + node.x + ',' + node.y + ')"><title>' + esc(node.label) + '</title><rect width="' + model.nodeWidth + '" height="' + model.nodeHeight + '"></rect><text class="node-type" x="14" y="20">' + esc(node.type) + '</text><text class="node-label" x="14" y="43">' + labelMarkup + '</text><text class="node-meta" x="14" y="74">' + esc(nodeMeta(node)) + '</text></g>'; }).join('');
    const transform = `translate(${state.graphPan.x} ${state.graphPan.y}) scale(${state.graphZoom})`; const graphHeight = model.compact ? Math.max(620, Math.min(1500, Math.round(model.height * 0.9))) : null; const filterNote = state.disputedOnly && model.nodes.length === 1 ? '<p class="graph-filter-empty">No disputed claims match this filter.</p>' : '';
    return `<div class="graph-wrap"><svg class="graph" style="height:${graphHeight ? graphHeight + 'px' : ''}" data-content-width="${model.width}" data-content-height="${model.height}" viewBox="0 0 ${model.width} ${model.height}" preserveAspectRatio="xMidYMin meet" aria-label="Interactive evidence graph"><defs>${['supports','contradicts','qualifies','derived_from','cites','possibly_same_origin','asks'].map(k => `<marker id="arrow-${k}" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto"><path d="M0,0 L0,6 L7,3 z"></path></marker>`).join('')}</defs><g class="graph-content" transform="${transform}">${edgeMarkup}${nodeMarkup}</g></svg>${filterNote}<div class="graph-legend"><span><i class="legend-question"></i>Question</span><span><i class="legend-claim"></i>Claim</span><span><i class="legend-source"></i>Source</span><span class="legend-edge"><i class="edge-swatch support"></i>Supports</span><span class="legend-edge"><i class="edge-swatch contradict"></i>Contradicts</span><span class="legend-edge"><i class="edge-swatch qualifies"></i>Qualifies</span><span class="legend-edge"><i class="edge-swatch cites"></i>Cites</span><span class="legend-edge"><i class="edge-swatch derived"></i>Derived from</span><span class="legend-edge"><i class="edge-swatch origin"></i>Same origin?</span></div><div class="graph-accessible"><h3>Graph list</h3>${model.nodes.map(node => `<button data-node="${esc(node.id)}" title="${esc(node.label)}"><b>${esc(node.type)}</b> ${esc(node.label)}</button>`).join('')}</div></div>`;
  }
  function nodeMeta(n) { return text(n.status, n.publisher, n.type === 'QUESTION' ? 'Investigation context' : n.type === 'SOURCE' ? 'Evidence source' : 'Click to inspect'); }

  function bindResearchEvents() {
    app.querySelectorAll('[data-node]').forEach(el => { el.addEventListener('click', () => selectNode(el.dataset.node)); el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectNode(el.dataset.node); } }); });
    app.querySelector('[data-action="zoom-in"]')?.addEventListener('click', () => { state.graphZoom = Math.min(1.5, +(state.graphZoom + .1).toFixed(2)); renderResearch(); });
    app.querySelector('[data-action="zoom-out"]')?.addEventListener('click', () => { state.graphZoom = Math.max(.55, +(state.graphZoom - .1).toFixed(2)); renderResearch(); });
    app.querySelector('[data-action="fit"]')?.addEventListener('click', () => { state.graphZoom = 1; state.graphPan = { x: 0, y: 0 }; renderResearch(); });
    app.querySelector('[data-action="disputed"]')?.addEventListener('change', e => { state.disputedOnly = e.target.checked; state.selected = null; state.graphPan = { x: 0, y: 0 }; renderResearch(); });
    app.querySelector('[data-action="report"]')?.addEventListener('click', () => { state.reportOpen = !state.reportOpen; renderResearch(); });
    const svg = app.querySelector('.graph'); const content = svg?.querySelector('.graph-content');
    if (!svg || !content) return;
    let drag = null;
    const clampPan = (x, y) => { const width = Number(svg.dataset.contentWidth || 0); const height = Number(svg.dataset.contentHeight || 0); return { x: Math.min(0, Math.max(width - width * state.graphZoom, x)), y: Math.min(0, Math.max(height - height * state.graphZoom, y)) }; };
    const applyPan = (x, y) => { const pan = clampPan(x, y); content.setAttribute('transform', `translate(${pan.x} ${pan.y}) scale(${state.graphZoom})`); };
    svg.addEventListener('pointerdown', event => { if (event.target.closest('.graph-node, .edge, .graph-accessible')) return; drag = { x: event.clientX, y: event.clientY, pan: { ...state.graphPan } }; svg.setPointerCapture?.(event.pointerId); svg.classList.add('panning'); });
    svg.addEventListener('pointermove', event => { if (!drag) return; const rect = svg.getBoundingClientRect(); const scale = modelScale(svg); const x = drag.pan.x + ((event.clientX - drag.x) / Math.max(1, rect.width)) * Number(svg.dataset.contentWidth) / scale; const y = drag.pan.y + ((event.clientY - drag.y) / Math.max(1, rect.height)) * Number(svg.dataset.contentHeight) / scale; applyPan(x, y); });
    const endPan = event => { if (!drag) return; const rect = svg.getBoundingClientRect(); const scale = modelScale(svg); state.graphPan = clampPan(drag.pan.x + ((event.clientX - drag.x) / Math.max(1, rect.width)) * Number(svg.dataset.contentWidth) / scale, drag.pan.y + ((event.clientY - drag.y) / Math.max(1, rect.height)) * Number(svg.dataset.contentHeight) / scale); drag = null; svg.classList.remove('panning'); svg.releasePointerCapture?.(event.pointerId); };
    svg.addEventListener('pointerup', endPan); svg.addEventListener('pointercancel', endPan);
  }
  function modelScale(svg) { return Math.max(0.01, Math.min(svg.clientWidth / Number(svg.dataset.contentWidth || 1), svg.clientHeight / Number(svg.dataset.contentHeight || 1))); }
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
    const related = arr(obj(s).relatedClaims).length ? obj(s).relatedClaims : arr(obj(s).claims).length ? obj(s).claims : arr(obj(d).evidenceEdges).filter(edge => String(text(edge.sourceId, edge.from, obj(edge.source).id, typeof edge.source === 'string' ? edge.source : '')) === s.id).map(edge => claims().find(claim => claim.id === edge.claimId)).filter(Boolean); const rels = arr(obj(d).sourceRelationships).filter(r => String(text(r.sourceId, r.from, obj(r.source).id, typeof r.source === 'string' ? r.source : '')) === idOf(s));
    return `<div class="inspector-head"><span class="section-kicker">SOURCE</span><span class="close-inspect" aria-hidden="true">×</span><h2>${esc(labelOf(s, idOf(s)))}</h2><span class="source-domain">${esc(text(s.publisher, s.domain, s.sourceType, 'Unclassified source'))}</span></div><div class="source-facts"><div><span>QUALITY</span><b>${esc(text(s.quality, s.qualityScore, s.reliability, 'Not rated'))}</b></div><div><span>RETRIEVAL ROLE</span><b>${esc(text(s.retrievalRole, s.searchRole, s.role, Array.isArray(s.retrievedBy) ? s.retrievedBy.join(', ') : '', s.purpose, 'Not specified'))}</b></div></div><div class="inspect-section"><h3>Excerpt</h3><blockquote>${esc(text(s.excerpt, s.snippet, s.quote, s.content, 'No excerpt was provided.'))}</blockquote></div><div class="inspect-section"><h3>Source metadata</h3><dl class="metadata"><div><dt>Published</dt><dd>${esc(text(s.publishedAt, s.publicationDate, 'Not recorded'))}</dd></div><div><dt>Retrieved</dt><dd>${esc(text(s.retrievedAt, s.accessedAt, 'Not recorded'))}</dd></div><div><dt>URL</dt><dd>${s.url || s.href ? `<a href="${esc(safeUrl(text(s.url, s.href)))}" target="_blank" rel="noopener noreferrer">Open source ↗</a>` : 'Not provided'}</dd></div></dl></div><div class="inspect-section"><h3>Related claims</h3>${sourceList(related, 'No related claims recorded.')}</div><div class="inspect-section"><h3>Lineage</h3><p class="muted">${esc(text(s.lineage, s.provenance, s.lineageGroupId ? `Lineage group ${s.lineageGroupId.slice(0, 8)}` : '', 'No lineage details recorded.'))}</p></div><div class="inspect-section"><h3>Source relationships</h3>${rels.length ? `<ul class="relationship-list">${rels.map(r => { const targetId = String(text(r.targetSourceId, r.to, obj(r.target).id, typeof r.target === 'string' ? r.target : '')); const target = sources().find(source => source.id === targetId); return `<li><b>${esc(text(r.type, r.relationship, 'RELATED'))}</b> ${esc(text(r.targetTitle, obj(r.target).title, r.to, target?.title, targetId, r.description, 'Relationship recorded'))}</li>`; }).join('')}</ul>` : '<p class="muted">No source relationships recorded.</p>'}</div>`;
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

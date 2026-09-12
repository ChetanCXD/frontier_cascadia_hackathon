# ClaimLens demo runbook

## The 60-second judge path

1. Run `npm start` and open `http://127.0.0.1:4173`.
2. Enter: **Will solid-state batteries reach mass-market electric vehicles before 2030?**
3. While the graph builds, call out the left timeline: Researcher searches first, then the separate Skeptic searches for counterevidence and caveats.
4. Click a claim. Show its status, 0–100 Evidence Strength, independent support/contradiction counts, source buckets, and the “why keep researching” note.
5. Click a source. Show retrieval role, excerpt, quality, publication/retrieval metadata, URL, and lineage group.
6. Click **View report**. Every finding is linked back to source IDs; the report is generated from the persisted graph.

## Legitimate fallback session

After a successful live run, create the fallback from the server's persisted state:

```bash
node scripts/save-demo.mjs <session-id>
```

This copies only the completed structured session to `data/demo-session.json` and sets an explicit `metadata.demo` flag. It does not create or alter research content. The landing page's saved-demo action is shown only when `/api/demo` returns that file. It is labeled as a previously completed research session.

To verify the fallback:

```bash
mv data/sessions data/sessions-live
mkdir -p data/sessions
npm start
# Open the saved-demo action; it should still load from data/demo-session.json.
```

Restore the live directory afterward. Do not use synthetic test fixtures as a demo session.

## Reliability checklist

- `npm test` passes before the demo.
- `GET /api/health` returns `{ "ok": true }`.
- Use a provider API key when available; otherwise the public DuckDuckGo adapter is used.
- Keep `MAX_SEARCH_CALLS` and `MAX_RESEARCH_ITERATIONS` bounded.
- If one source fails, the timeline records it and the rest of the graph/report remains available.
- If the network is unavailable, show the saved real session rather than claiming a live run.
- Refreshing `#/research/<id>` reloads the persisted graph and report.

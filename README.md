# ClaimLens

### Research that tries to prove itself wrong.

### Video is the file named "Video Submission(1)(1).mp4"

ClaimLens is an evidence debugger for research questions. Instead of returning a list of citations, it builds a claim-level evidence graph, runs a separate skeptic search, traces repeated source origins, and shows what the evidence does—and does not—support.

> AI can produce a researched answer in seconds. The harder problem is knowing whether its evidence is independent, whether credible evidence contradicts it, and what it still does not know.

## What works in the MVP

- **Researcher + skeptic roles**: initial searches prefer direct and primary evidence; a distinct skeptic stage searches for counterevidence, caveats, and limitations and records its sources separately.
- **Structured evidence graph**: sessions, tasks, claims, sources, evidence edges, source relationships, adjudications, and agent events are persisted as first-class JSON entities.
- **Genealogy-aware evidence**: canonical URL deduplication, explicit page links, and high-overlap text are used to mark `CITES`, `DERIVED_FROM`, or `POSSIBLY_SAME_ORIGIN`. Correlated sources count as one independent lineage.
- **Transparent adjudication**: claims become `SUPPORTED`, `CONTRADICTED`, `MIXED`, or `UNCERTAIN`. The 0–100 Evidence Strength score is a readable heuristic based on source quality, independent corroboration, balance, coverage, and qualifications—not a calibrated probability.
- **Uncertainty loop**: weak, mixed, or low-strength claims generate bounded targeted follow-up research for independent primary data.
- **Live workspace**: a dark, responsive SPA shows progress, role-specific activity, an interactive SVG graph, claim/source inspectors, and a citation-backed final report.
- **Honest fallback**: a completed real session can be saved as `data/demo-session.json` and loaded with an explicit “previously completed” label. No fixture result is presented as live research.

## Run it

Requirements: Node.js 20+, an installed Pi CLI, authenticated `openai-codex` subscription, the `pi-web-access` extension, and network access for live research. No frontend build step or third-party runtime package is required.

```bash
cp .env.example .env
npm test
npm start
```

Open <http://127.0.0.1:4173>. Use the example question:

> Does intermittent fasting improve weight loss compared with calorie restriction?

Normal `POST /api/sessions` runs the installed Pi process in read-only mode. Pi is explicitly restricted to the `pi-web-access` `web_search` and `get_search_content` tools and uses inherited Codex authentication. Missing Pi, Codex authentication, the extension, or a successful web-search receipt fails the session closed; there is no search-provider fallback.

Verify the live prerequisites before starting:

```bash
pi --version
pi auth check --provider openai-codex --json --no-refresh
test -f "$HOME/.pi/agent/npm/node_modules/pi-web-access/index.ts"
```

For tests only, inject a clearly labeled fixture runner or `fixtureMode` with a fixture search client (as the automated tests do). Fixture mode is never selected by a normal request and never produces live evidence.

Useful configuration:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `4173` | HTTP port |
| `HOST` | `127.0.0.1` | Bind address |
| `DATA_DIR` | `./data/sessions` | Durable session JSON directory |
| `PI_EXECUTABLE` | `pi` | Installed Pi executable |
| `PI_PROJECT_DIR` | `/home/chetan/pi_frontier` | Exact Pi working directory |
| `PI_WEB_SEARCH_EXTENSION` | `$HOME/.pi/agent/npm/node_modules/pi-web-access/index.ts` | Pinned pi-web-access extension |
| `PI_PROVIDER` | `openai-codex` | Codex subscription provider |
| `PI_MODEL` | `gpt-5.6-luna` | Pi model |
| `PI_TIMEOUT_MS` | `1800000` | Per-worker timeout (30 minutes) |
| `PI_MAX_CONCURRENT_WORKERS` | `1` | Concurrent Pi worker bound |
| `PI_MAX_CONTENT_CALLS` | `32` | Bounded retrieved-content calls per worker |
| `MAX_SEARCH_CALLS` | `8` | Hard total web-search-call budget per session |
| `MAX_SOURCES` | `28` | Hard source budget per session |
| `MAX_RESEARCH_ITERATIONS` | `2` | Initial pass plus at most one follow-up pass |

Every session is written atomically to `DATA_DIR`, so a browser refresh or a single failed source does not erase partial evidence.

## Demo workflow

1. Start the server and submit a question.
2. Watch **Researcher** activity populate the map.
3. Point out **Skeptic** searches and the red contradiction/amber qualification edges.
4. Click a claim to see its status, Evidence Strength factors, and source buckets.
5. Click a source to inspect its excerpt, retrieval role, quality, URL, and lineage group.
6. Open **View report** for the executive conclusion, findings, limitations, and `[source-id]` citations.
7. After a successful real run, save it as an explicit fallback:

```bash
node scripts/save-demo.mjs <session-id>
```

The landing page only offers the saved-demo button when that file is present and valid. See [`DEMO.md`](DEMO.md) for the judge walkthrough and reliability notes.

## Architecture

```text
question
  -> planner
  -> installed Pi researcher + pi-web-search retrieval
  -> source-grounded atomic claims and typed evidence edges
  -> distinct Pi skeptic pass for contradiction / qualification
  -> source genealogy and independent-lineage analysis
  -> adjudicator (status + factors + score)
  -> weakness detector -> targeted follow-up (bounded)
  -> graph + claim-level report
```

The server is a small Node ESM application using the built-in HTTP server and an atomic JSON repository. The browser client is plain HTML/CSS/JS and renders the graph with SVG so a clean clone has no dependency install or bundler failure mode. Pi search receipts, source metadata, excerpts, and citations are validated before persistence; raw assistant streams and chain-of-thought are never persisted. Deterministic domain scoring, genealogy, and report projection remain inspectable and compatible with fixture tests.

### API

- `GET /api/health`
- `POST /api/sessions` with `{ "question": "..." }` (returns `202` and `sessionId`)
- `GET /api/sessions/:id` — durable snapshot
- `GET /api/sessions/:id/events?after=<cursor>` — progress polling
- `GET /api/sessions/:id/graph`
- `GET /api/sessions/:id/report`
- `GET /api/demo` — only when a legitimate saved demo exists

Important entities are validated at construction time and carry timestamps and provenance. The UI never displays chain-of-thought; event payloads are concise action summaries such as “Skeptic is searching for contradictions.”

## Test coverage

```bash
npm test
```

Tests cover URL canonicalization, source deduplication, source genealogy, independent evidence collapse, all four adjudication states, weakness/follow-up generation, report citation safety, durable persistence, deterministic fixture compatibility, Pi schema/receipt grounding, split JSONL activity, Pi process failures, injected Pi role separation, and the HTTP API. Synthetic Pi/search fixtures are clearly labeled and never masquerade as live research.

The live evaluator (`node scripts/evaluate-live.mjs`, with installed Pi and Codex authentication) exercises:

1. a conflicting weight-loss question,
2. a repeated-source/current-rate lineage question,
3. a consensus health question, and
4. a question with genuinely insufficient evidence.

It writes inspectable snapshots to `data/evaluations/` and fails assertions if the runs do not complete, retain receipts/citations, execute skeptic and follow-up roles, and surface the expected graph behavior.

Results can be partial when a provider or page is unavailable; the session remains inspectable and terminates at its hard budgets.

## Limitations

- Pi web-search availability, network access, and page retrieval are best-effort; configuration or tool failures fail closed.
- Extractive classification is not a substitute for human review or a calibrated fact-checking model.
- Source genealogy is explicitly marked as inferred when based on overlap, and cannot prove common origin from text alone.
- The JSON repository is intentionally simple for a hackathon MVP; use a database and job queue for multi-user production workloads.
- Search results and source excerpts are untrusted web text and are never executed.

## Technologies

Node.js ESM, built-in `http` and `fetch`, atomic JSON persistence, vanilla browser JavaScript, SVG, and CSS. Pi is the live runtime; deterministic search adapters are test-only fixtures.

## Attribution and AI use

See [`AI_USAGE.md`](AI_USAGE.md). No existing application code was available in the target directory; the MVP was bootstrapped there during this build. Git history is not rewritten or deleted.

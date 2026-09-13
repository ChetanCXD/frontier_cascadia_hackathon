# AI_USAGE.md

## AI systems and tools

- **Pi / Pi Agent**: used as the coding-agent harness for repository audit, implementation, testing, integration, and quality review.
- **pi-subagents**: used for parallel repository, domain, frontend, and reliability audits, plus bounded implementation handoffs. The parent agent retained architecture, integration, and final verification responsibility.
- **Primary coding model**: the active Pi session model/provider was `openai-codex / gpt-5.6-luna` (configured session tier). Pricing/quota is controlled by the local OpenAI/Codex account; no claim is made here about a free tier.
- **Runtime research provider**: Normal sessions use the installed Pi CLI with the `pi-web-access` `web_search` and `get_search_content` tools and inherited `openai-codex` subscription authentication. The repository does not contain credentials. Missing runtime configuration or successful tool receipts fails closed; no provider fallback is used.

## What AI assisted with

- Product architecture and prioritization for the evidence-debugger vertical slice.
- Runtime-validated entity schemas and graph algorithms for claims, sources, evidence edges, source genealogy, independent-lineage counting, adjudication, and follow-up selection.
- Node HTTP API, bounded researcher/skeptic pipeline, source retrieval/parser, persistence, SVG graph UX, inspectors, report rendering, tests, README, and demo instructions.
- Test fixture design and adversarial review criteria.

## What the application does at runtime

The application does **not** expose model chain-of-thought or raw assistant streams. It records concise stage/tool events and structured provenance only. A session uses distinct Pi Researcher, Skeptic, and bounded Follow-up passes. Pi output is schema-validated against successful web-search receipts before persistence; only actual URLs, metadata, excerpts, atomic claims, typed edges, assessments, and grounded citations are retained. Deterministic, inspectable scoring, genealogy, and report projection remain downstream compatibility logic.

No source, citation, research conclusion, or saved demo result is intentionally fabricated. Synthetic data appears only in automated tests and is labeled as fixtures. A saved demo is created only from a completed real session by `scripts/save-demo.mjs`.

## Major technologies

- Node.js built-in HTTP server, `fetch`, filesystem APIs, and ES modules.
- Vanilla HTML/CSS/JavaScript and SVG for a zero-build browser client.
- Pi CLI, pi-web-access, and the OpenAI Codex subscription provide live research. Deterministic providers/search fixtures are test-only and must be explicitly injected.

## Human review and limitations

AI-assisted implementation does not make evidence scores calibrated probabilities or source genealogy certain. Users should inspect the linked source excerpts, open original URLs, and treat `MIXED`/`UNCERTAIN` results as unresolved. Network failures, unavailable Codex auth, Pi timeouts, web-search failures, paywalls, parser limitations, and search ranking can produce a failed or partial session. Fixture mode is for automated tests only and is clearly labeled.

# AI_USAGE.md

## AI systems and tools

- **Pi / Pi Agent**: used as the coding-agent harness for repository audit, implementation, testing, integration, and quality review.
- **pi-subagents**: used for parallel repository, domain, frontend, and reliability audits, plus bounded implementation handoffs. The parent agent retained architecture, integration, and final verification responsibility.
- **Primary coding model**: the active Pi session model/provider was `openai-codex / gpt-5.6-luna` (configured session tier). Pricing/quota is controlled by the local OpenAI/Codex account; no claim is made here about a free tier.
- **Runtime research providers**: ClaimLens has adapters for public DuckDuckGo HTML search and optional Brave Search, Tavily, and Serper API keys. The repository does not contain credentials. Live results are fetched at runtime and remain attributable to their source URLs.

## What AI assisted with

- Product architecture and prioritization for the evidence-debugger vertical slice.
- Runtime-validated entity schemas and graph algorithms for claims, sources, evidence edges, source genealogy, independent-lineage counting, adjudication, and follow-up selection.
- Node HTTP API, bounded researcher/skeptic pipeline, source retrieval/parser, persistence, SVG graph UX, inspectors, report rendering, tests, README, and demo instructions.
- Test fixture design and adversarial review criteria.

## What the application does at runtime

The application does **not** expose model chain-of-thought. It records concise stage events and structured provenance only. A session uses the Researcher role for initial searches and a distinct Skeptic role for counterevidence searches. It then applies deterministic, inspectable extraction/classification and scoring heuristics. Source URLs, excerpts, retrieval timestamps, search role, and lineage relationships are stored so a user can audit the result.

No source, citation, research conclusion, or saved demo result is intentionally fabricated. Synthetic data appears only in automated tests and is labeled as fixtures. A saved demo is created only from a completed real session by `scripts/save-demo.mjs`.

## Major technologies

- Node.js built-in HTTP server, `fetch`, filesystem APIs, and ES modules.
- Vanilla HTML/CSS/JavaScript and SVG for a zero-build browser client.
- DuckDuckGo HTML, Brave Search, Tavily, and Serper are optional external search services.

## Human review and limitations

AI-assisted implementation does not make evidence scores calibrated probabilities or source genealogy certain. Users should inspect the linked source excerpts, open original URLs, and treat `MIXED`/`UNCERTAIN` results as unresolved. Network failures, paywalls, parser limitations, and search ranking can produce partial results.

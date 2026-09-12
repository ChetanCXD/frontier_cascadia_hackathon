# Live evaluation evidence

`node scripts/evaluate-live.mjs` runs four real web-backed questions through the same bounded pipeline used by the UI. It writes an assertion-checked summary plus inspectable, source-bearing artifacts under `data/evaluations/`; no synthetic source is inserted. The following run used the public DuckDuckGo adapter on 2026-09-12.

| Case | Session | Artifact | Sources | Claims | Evidence edges | Adjudication | Skeptic searches | Follow-ups |
| --- | --- | --- | ---: | ---: | ---: | --- | ---: | ---: |
| conflicting weight-loss evidence | `c24f443b-4525-441c-a510-73a53d00e6bc` | `data/evaluations/conflicting.json` | 9 | 4 | 23 | 1 UNCERTAIN, 3 MIXED | 3 | 1 |
| repeated source/current-rate lineage | `0f1179d5-faa3-460b-93cf-7edf4734cccb` | `data/evaluations/repeated-lineage.json` | 12 | 4 | 38 | 1 UNCERTAIN, 3 SUPPORTED | 3 | 1 |
| consensus health question | `7b10d3df-0fef-4782-9b6d-b78b34790e6f` | `data/evaluations/consensus.json` | 11 | 4 | 29 | 1 SUPPORTED, 3 MIXED | 3 | 1 |
| insufficient private-company forecast | `f6b17b50-4a5f-4f9b-b185-e84cf737db3b` | `data/evaluations/insufficient.json` | 12 | 4 | 5 | 4 UNCERTAIN | 3 | 1 |

The evaluator asserts for every case: `COMPLETE` status, a completion event/timestamp, retrieved HTTP(S) source receipts (or recorded fetch errors), non-empty evidence quotes, at least one researcher and skeptic search, a completed bounded follow-up task, valid genealogy endpoint/confidence data, and source-valid report citations. It additionally asserts both `SUPPORTS` and `CONTRADICTS` plus `MIXED` adjudication for the conflicting case; `POSSIBLY_SAME_ORIGIN` for repeated-lineage; `SUPPORTS` for consensus; and `UNCERTAIN` for insufficient evidence. These are runtime observations, not calibrated benchmark labels; web rankings and page availability can change between runs. The intermittent-fasting demo was run with the full budget and separately saved as `data/demo-session.json`; it contains real skeptic contradictions, suspected shared-origin relationships, inferred `DERIVED_FROM` relationships, and follow-up tasks.

Each committed artifact contains the case/question, `realRun: true`, provider label, persisted events, researcher/skeptic/follow-up source roles, sources with URLs and excerpts, claims, evidence edges, genealogy relationships, adjudications, and the citation-safe report. Failed pages remain explicitly represented with `fetchError` rather than being silently treated as evidence.

## Failure-path evidence

The automated failure tests simulate a provider timeout and a page timeout. They verify that search errors become structured errors/events, partial source state is retained when available, and the pipeline still terminates with a report rather than spinning or crashing.

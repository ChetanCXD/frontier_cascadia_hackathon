# Live evaluation evidence

`node scripts/evaluate-live.mjs` runs four real web-backed questions through the same bounded pipeline used by the UI. It writes an assertion-checked summary plus inspectable, source-bearing artifacts under `data/evaluations/`; no synthetic source is inserted. The following run used the public DuckDuckGo adapter on 2026-09-12.

| Case | Session | Artifact | Sources | Claims | Evidence edges | Adjudication | Skeptic searches | Follow-ups |
| --- | --- | --- | ---: | ---: | ---: | --- | ---: | ---: |
| conflicting lifecycle comparison | `1f81bbd0-f0a5-4375-b3e7-e87c3e27698b` | `data/evaluations/conflicting.json` | 10 | 4 | 29 | 1 UNCERTAIN, 3 SUPPORTED | 2 | 0 |
| repeated-source battery timeline | `101ec1d2-14f1-42d0-a70f-f48cb6f77883` | `data/evaluations/repeated-lineage.json` | 9 | 4 | 29 | 1 UNCERTAIN, 3 MIXED | 2 | 0 |
| consensus health question | `95a7895d-df95-40b4-876f-ad99c1252640` | `data/evaluations/consensus.json` | 10 | 4 | 32 | 1 UNCERTAIN, 3 MIXED | 2 | 0 |
| insufficient private-company forecast | `1e59d658-e16c-4acb-b39f-7e687b3dee27` | `data/evaluations/insufficient.json` | 10 | 4 | 17 | 2 UNCERTAIN, 2 SUPPORTED | 2 | 0 |

Each committed artifact contains the case/question, `realRun: true`, provider label, persisted events, researcher/skeptic source roles, sources with URLs and excerpts, claims, evidence edges, genealogy relationships, adjudications, and the citation-safe report. The script asserts that every case completes with a report, real retrieved sources, claims, at least one skeptic search, and source-valid report citations. It also asserts that the insufficient-evidence case retains an `UNCERTAIN` central proposition. These are runtime observations, not calibrated benchmark labels; web rankings can change between runs. The battery demo was run with the full budget and separately saved as `data/demo-session.json`; it contains real skeptic contradictions, suspected shared-origin relationships, inferred `DERIVED_FROM` relationships, and follow-up tasks.

## Failure-path evidence

The automated failure tests simulate a provider timeout and a page timeout. They verify that search errors become structured errors/events, partial source state is retained when available, and the pipeline still terminates with a report rather than spinning or crashing.

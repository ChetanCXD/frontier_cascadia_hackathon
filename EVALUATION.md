# Live evaluation evidence

`node scripts/evaluate-live.mjs` runs four real web-backed questions through the same bounded pipeline used by the UI. It writes a local, ignored `data/evaluation-summary.json`; no synthetic source is inserted. The following assertion-enabled run used the public DuckDuckGo adapter on 2026-09-12.

| Case | Session | Sources | Claims | Evidence edges | Adjudication | Skeptic searches | Follow-ups |
| --- | --- | ---: | ---: | ---: | --- | ---: | ---: |
| conflicting lifecycle comparison | `a2be68aa-cf25-479c-86c8-c145c8b413bb` | 10 | 4 | 22 | 4 SUPPORTED | 2 | 0 |
| repeated-source battery timeline | `965c2e03-c992-4fc9-9e4b-e832c3c5109f` | 9 | 4 | 28 | 1 UNCERTAIN, 3 MIXED | 2 | 0 |
| consensus health question | `edae9a03-ba34-49da-a038-73d43261ecf6` | 10 | 4 | 27 | 1 UNCERTAIN, 3 CONTRADICTED | 2 | 0 |
| insufficient private-company forecast | `3c09a184-e762-4e07-8130-803c3349a7f4` | 10 | 4 | 15 | 2 UNCERTAIN, 2 SUPPORTED | 2 | 0 |

The script asserts that every case completes with a report, real retrieved sources, claims, at least one skeptic search, and source-valid report citations. It also asserts that the insufficient-evidence case retains an `UNCERTAIN` central proposition. These are runtime observations, not calibrated benchmark labels; web rankings can change between runs. The battery demo was run with the full budget and separately saved as `data/demo-session.json`; it contains real skeptic contradictions, suspected shared-origin relationships, inferred `DERIVED_FROM` relationships, and follow-up tasks.

## Failure-path evidence

The automated failure tests simulate a provider timeout and a page timeout. They verify that search errors become structured errors/events, partial source state is retained when available, and the pipeline still terminates with a report rather than spinning or crashing.

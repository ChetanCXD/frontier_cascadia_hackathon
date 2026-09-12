# Live evaluation evidence

`node scripts/evaluate-live.mjs` runs four real web-backed questions through the same bounded pipeline used by the UI. It writes a local, ignored `data/evaluation-summary.json`; no synthetic source is inserted. The following run used the public DuckDuckGo adapter on 2026-09-12.

| Case | Session | Sources | Claims | Evidence edges | Adjudication | Skeptic searches | Follow-ups |
| --- | --- | ---: | ---: | ---: | --- | ---: | ---: |
| conflicting lifecycle comparison | `22e77d28-d670-48b2-9de3-14f5f18fbb74` | 9 | 4 | 24 | 1 UNCERTAIN, 3 SUPPORTED | 2 | 0 |
| repeated-source battery timeline | `cc906257-7339-449d-a0e1-d45234a8fd5b` | 9 | 4 | 28 | 1 UNCERTAIN, 3 MIXED | 2 | 0 |
| consensus health question | `992fe316-63ea-4a9b-9a99-072bf7766ebc` | 10 | 4 | 36 | 1 UNCERTAIN, 3 MIXED | 2 | 0 |
| insufficient private-company forecast | `ff2c34e4-159d-48a4-aa72-0f5c5fd6648c` | 10 | 4 | 18 | 1 UNCERTAIN, 3 SUPPORTED | 2 | 0 |

These are runtime observations, not calibrated benchmark labels. The intentionally narrow central proposition is marked `UNCERTAIN` when retrieved material does not directly establish it; extractive claims from relevant source pages can still be `SUPPORTED`. The battery demo was run with the full budget and separately saved as `data/demo-session.json`; it contains real skeptic contradictions, suspected shared-origin relationships, inferred `DERIVED_FROM` relationships, and follow-up tasks.

## Failure-path evidence

The automated failure tests simulate a provider timeout and a page timeout. They verify that search errors become structured errors/events, partial source state is retained when available, and the pipeline still terminates with a report rather than spinning or crashing.

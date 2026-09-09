# Run result schema

Write `result.json` to `$WORK_DIR/runs/<runId>/result.json` with `schemaVersion: 1`.
Write `audit.md` next to it. Never include `GITHUB_TOKEN`, `.env` contents, clone URLs with credentials, or redacted secret material.

Helpers consume `result.json` during `npm run complete-run -- --run-id <runId>` then `npm run finalize -- --run-id <runId>`. The parent derives verdict fields from the loop ledger and recorded logs; do not copy the writer's PLAYBOOK trailer blindly if it disagrees with that evidence.

## `result.json`

```json
{
  "schemaVersion": 1,
  "repo": "<org repo name>",
  "branch": "<upgrade branch from prepare>",
  "baseSha": "<BASELINE_SHA / prepare baseSha>",
  "baselineFailures": 0,
  "baselineFailureNames": ["Fully.Qualified.Test.Name"],
  "buildPassed": true,
  "testsRegressed": false,
  "reviewers": "PASS",
  "upgradeResult": "SUCCESS",
  "rounds": 1,
  "unresolvedCriticals": [],
  "warnings": [],
  "implementationSummary": "<what changed and why>",
  "testsRun": ["dotnet build — passed", "dotnet test — passed"],
  "residualRisks": []
}
```

| Field | Type | Notes |
| :--- | :--- | :--- |
| `schemaVersion` | number | Always `1` (`RESULT_SCHEMA_VERSION`). |
| `repo` | string | Repository name from prepare/select. |
| `branch` | string | Upgrade branch (`upgradeBranch` from prepare). |
| `baseSha` | string | Clean clone `HEAD` at Stage 0. |
| `baselineFailures` | number | Count of baseline test failures still failing; `0` if none. |
| `baselineFailureNames` | string[] | Fully-qualified names of those carried-forward failures. |
| `buildPassed` | boolean | Final `dotnet build` in the clone passed. |
| `testsRegressed` | boolean | A test that passed in the baseline now fails. If the baseline build failed, any remaining test failure is a regression against the strict bar. |
| `reviewers` | `"PASS"` \| `"FAIL"` | `PASS` only if both reviewers returned `PASS` with zero criticals. |
| `upgradeResult` | `"SUCCESS"` \| `"FAILED"` | `SUCCESS` only if `buildPassed` and `testsRegressed` is false. |
| `rounds` | number | Writer rounds actually dispatched (1–4). |
| `unresolvedCriticals` | array | Outstanding critical findings (title, file, evidence) or empty. |
| `warnings` | array | Non-blocking warnings/suggestions collected across reviews. |
| `implementationSummary` | string | Loop Stage 4 summary. Truncate if huge; never include secrets. |
| `testsRun` | string[] | One line per command and actual result from writer logs. |
| `residualRisks` | array | Known limitations, carried baseline failures, follow-up work. |

`complete-run` / `finalize` are allowed only when all of these are true:

- `reviewers` is `PASS`
- `upgradeResult` is `SUCCESS`
- `buildPassed` is true
- `testsRegressed` is false
- `unresolvedCriticals` is empty

## `audit.md`

Redact anything that looks like a token. Include:

- Run identities: `repo`, `runId`, `branch`, `baseSha`, `TARGET_REPO_PATH`, `RUN_DIR`
- Stage 0 cleanliness check
- Writer round summaries (`implementation_summary`, `tests_run`, `triage_decisions`)
- Raw adversarial and architectural reviews (full text)
- Rejection ledger
- Paths to persisted `dotnet --info` / build / test logs
- Warnings and residual risks
- Finalize decision and reason (ran vs skipped)

Do not paste helper stdout that could contain clone URLs with embedded credentials.

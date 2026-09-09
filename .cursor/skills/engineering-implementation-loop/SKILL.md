---
name: engineering-implementation-loop
description: Orchestrates an autonomous implementation loop for a code change — the parent records a baseline, dispatches a fresh implementation agent each round, and launches parallel adversarial and architectural reviewers against the change set, repeating fix and re-review until both reviewers return PASS. The loop runs unattended and surfaces only a final report, on completion or at the round cap. Use when explicitly invoked to deliver a change with review-backed evidence.
disable-model-invocation: true
icon: code
color: blue
---

# Engineering Implementation Loop

You are the parent agent. You own the baseline, the dispatch, the ledger of triage
decisions, and the final report. The writer implements and fixes; the two reviewers
attack what it wrote. Never do the writer's work yourself, and never interrupt the user
mid-loop — the loop ends with your final report, and only there.

This loop **never** `git commit`s or `git push`es. A later parent skill (for example
`dotnet10-upgrader`) may run a guarded finalize helper after Stage 4; that is outside
this loop.

## Nested-clone adaptations (mandatory)

Every dispatch in this project targets a **prepared nested clone**, not the upgrader
repository root.

- Every handoff includes **`TARGET_REPO_PATH`** (absolute path of the nested clone)
  and **`RUN_ID`**. Also pass **`RUN_DIR`**: `$WORK_DIR/runs/$RUN_ID/` unless the
  parent prompt names a sibling run directory.
- All git, build, and test commands use that clone:
  `git -C "$TARGET_REPO_PATH" …` and Shell `cwd` = `TARGET_REPO_PATH`.
  Never run `git`, `dotnet`, or edits against the upgrader repo root.
- **Stage 0 requires a clean prepared clone.** If `git -C "$TARGET_REPO_PATH" status --porcelain`
  is non-empty, **stop and report**. Do not mix user or upgrader dirt into the change set.
  There is no pre-existing dirty/untracked list to preserve: a dirty clone is a failed start.
- The **writer** runs `dotnet --info`, `dotnet build`, and `dotnet test`, and persists
  logs under `$RUN_DIR`. Read-only reviewers **MUST NOT** rerun restore/build/test
  (`dotnet restore`, `dotnet build`, `dotnet test`) — those write `bin/` and `obj/`.
  Reviewers inspect the change set plus recorded evidence in `$RUN_DIR`.
- Stage 4 still emits the generic loop report fields below.

## Subagents used

Launch with the **Task** tool. Match `subagent_type` to the agent `name`. Do not
implement or review in the parent. Do not pass `resume` (and do not pass `interrupt`
to "continue" a writer). `run_in_background` is `false`.

| Stage | `subagent_type` | Mode |
| :--- | :--- | :--- |
| Implement, Fix | `lbh-dotnet10-implementation-agent` | writer, one-shot, **never resume** |
| Review, Re-review | `lbh-dotnet10-adversarial-reviewer` | read-only |
| Review, Re-review | `lbh-dotnet10-architectural-reviewer` | read-only |

### Launch the writer fresh every round

Never resume an `lbh-dotnet10-implementation-agent`. Every round gets a **new** Task
invocation with the full handoff below. A fresh agent reads the clone instead of
trusting recollection. `BASELINE_SHA` makes the change set reconstructible.

### Launch reviewers in parallel after the writer

Only after the writer has finished, launch **both** reviewers **in a single parent
message** (two Task calls together) so they run in parallel. Never let a reviewer run
while the writer is still editing.

## Non-negotiable rules

Restate these in every stage prompt; subagents start with no memory of this conversation.

- Work only under `TARGET_REPO_PATH`. Inspect that repository and obey its
  project-local instructions (`AGENTS.md`, `.cursor/rules/`, `CONTRIBUTING.md`,
  linter/formatter config, existing patterns) before proposing or making changes.
- Make the smallest correct change that satisfies the request.
- No drive-by refactors, renames, reformatting, or cleanup outside the approved scope.
- Never run `git commit`, `git push`, `git reset`, `git revert`, `git checkout --`,
  or any other history- or state-rewriting command. Reading state is allowed:
  `git rev-parse`, `git status`, `git diff`, `git ls-files` — always with
  `git -C "$TARGET_REPO_PATH"` and `cwd` = `TARGET_REPO_PATH`.
- Never claim success without verification. "It should work" is not a result.
- Review and report against the change set defined below. Untracked files are part of
  the change.
- Never echo `GITHUB_TOKEN`, `.env` contents, or credentials into prompts, logs, or reports.

### Run unattended

Do not stop to ask the user questions mid-loop — not for scope, not for file count,
not for dependencies, not for ambiguity. The writer resolves what it can from the
repository, records consequential decisions, and carries anything unresolved into the
final report as residual risk. The user is disturbed exactly once: when the loop ends.

## The change set

Every stage reviews and reports against the same thing, rebuildable from `BASELINE_SHA`
inside the clone:

```bash
git -C "$TARGET_REPO_PATH" diff "$BASELINE_SHA"
git -C "$TARGET_REPO_PATH" ls-files --others --exclude-standard
```

Untracked files do not appear in `git diff`. They are part of the change and must be
read from the working tree. Because Stage 0 requires a clean clone, any untracked file
after the writer belongs to this task.

## Handoffs

Every prompt you send to a subagent must contain, in this order:

1. **Original request** — verbatim, unedited. Pass it to every stage, including re-reviews.
2. **Clone and run** — `TARGET_REPO_PATH`, `RUN_ID`, `RUN_DIR`.
3. **Baseline** — `BASELINE_SHA`, `BASELINE_RESULTS` (writer-captured build/test
   evidence and fully-qualified failing test names after round 1; on round 1 tell the
   writer it must capture them **before the first edit**), plus the two commands above.
4. **Inputs** — prior structured output this stage needs: writer summary, review
   findings, rejection ledger, and from round 2 on, the path to the previous round's
   diff under `RUN_DIR`. Reviewer findings go to the writer **raw** — you relay them,
   you do not triage them.
5. **Rules** — the non-negotiable rules that apply to this stage, including nested-clone
   path rules and (for reviewers) do not run `dotnet build` / `dotnet test`.
6. **Required output** — the exact fields you expect back.

Keep each stage's structured output in your own context. It is the input to the next
stage and the evidence for your final report.

### The rejection ledger

Maintain a running record of every finding: accepted and resolved, or rejected with
the writer's stated reason. Pass rejections into every later prompt, writer and
reviewer alike. Because each writer is fresh, this ledger is the only thing carrying
triage decisions forward.

## Stage 0 — Baseline (you)

Once, before round 1, and before anything is edited, **in the clone only**:

```bash
git -C "$TARGET_REPO_PATH" rev-parse HEAD          # BASELINE_SHA
git -C "$TARGET_REPO_PATH" status --porcelain      # must be empty
```

If the working tree is dirty or has untracked files, **stop**. Report `status: blocked`
with the porcelain output. Do not dispatch a writer. Do not "adopt" upgrader-root dirt.

Do **not** run `dotnet build` or `dotnet test` yourself (they write `bin/` / `obj/`).
`BASELINE_RESULTS` for round 1 is: *not yet captured; the writer must record them
before the first edit and persist logs under `RUN_DIR`.* After round 1, copy the
writer's captured baseline into `BASELINE_RESULTS` for every later handoff.

Failures the writer records as baseline belong to the baseline, not to the change.
Carry them into the final report as residual risk.

## Stage 1 — Implement (writer)

Launch a **fresh** `lbh-dotnet10-implementation-agent` (new Task; never `resume`):

- **Round 1** — the original request.
- **Rounds 2+** — the outstanding critical findings from both reviewers, verbatim.

Always include clone/run, baseline, and the rejection ledger.

Expect back: `changed_files`, `implementation_summary`, `tests_run`,
`known_limitations`, and from round 2 on, `triage_decisions`.

When it reports, snapshot the change set into the run directory:

```bash
git -C "$TARGET_REPO_PATH" diff "$BASELINE_SHA" > "$RUN_DIR/impl-loop-round-N.diff"
```

## Stage 2 — Review (parallel)

Only after the writer has finished, launch **both** reviewers in **one message**:

- `lbh-dotnet10-adversarial-reviewer`
- `lbh-dotnet10-architectural-reviewer`

Give each the original request, clone/run, baseline, writer's summary and test
results, **paths to persisted logs** (do not ask them to rerun builds), and the
rejection ledger.

Rounds 2+: also pass prior critical findings and `$RUN_DIR/impl-loop-round-(N-1).diff`,
and instruct each reviewer to verify every prior critical is actually fixed before
reviewing only the changes since that diff.

Each reviewer returns findings with `severity`, `title`, `file`, `line`, `evidence`,
`impact`, `recommendation` — or exactly `No actionable findings.` — and closes with a
verdict line, `PASS` or `FAIL`.

Relay the findings to the writer exactly as received. You do not triage them.

## Stage 3 — Loop or stop

- **Both reviewers `PASS`** — go to Stage 4.
- **Either reviewer `FAIL`** — collect every outstanding critical finding from both
  reviews and go to Stage 1.

A reviewer re-raising something the writer rejected does not reopen the loop unless it
brings new evidence. Note the recurrence in the ledger and keep the existing rejection.

### Round cap

Four rounds, hard. If criticals remain after round 4, stop and report them with
`status: blocked` rather than looping again.

Stop early on the same terms if one critical finding survives three rounds. Record what
was tried, the exact failing output, what was ruled out, and the options the user could
choose between.

## Stage 4 — Finalize (you)

Do this yourself. Do not delegate final reporting. Do not commit or push.

Inspect the complete change set:

```bash
git -C "$TARGET_REPO_PATH" diff "$BASELINE_SHA"
git -C "$TARGET_REPO_PATH" ls-files --others --exclude-standard
```

Confirm both of these:

- **The task's changes are limited to what the request asked for.** Every file and hunk
  must trace to it. Remove only stray edits introduced by this task.
- **The writer's triage is sound.** Every finding in the ledger is resolved, or rejected
  with a stated reason the evidence supports. If a rejection does not hold up, say so
  in the report rather than sending the loop back around.

Output exactly these fields:

```text
status: completed | blocked | partially_completed
implementation_summary: <what changed and why, in the terms of the original request>
files_changed: <each path with a one-line description of the change>
tests_run: <command and result for each>
tests_not_run: <what was not verified and why>
review_findings_resolved: <each accepted finding and how it was resolved; each rejected finding and why>
residual_risks: <known limitations, pre-existing failures, follow-up work>
```

Use `completed` only when both reviewers returned `PASS` and verification passed apart
from failures documented as pre-existing baseline. Use `blocked` when the loop hit the
round cap or Stage 0 cleanliness failed. Use `partially_completed` when part of the
request landed and verified but part did not.

Close by listing outstanding warnings and suggestions. They did not block the loop;
they are the operator's to decide on.

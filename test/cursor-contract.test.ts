import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isFinalizable, parseUpgradeResult } from "../src/upgrade";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cursor = path.join(root, ".cursor");

function read(rel: string): string {
  return fs.readFileSync(path.join(cursor, rel), "utf8");
}

/**
 * Collapses runs of whitespace so an assertion pins the wording of a rule rather than
 * where its paragraph happens to wrap. Reflowing a prompt must not turn CI red.
 */
function flat(text: string): string {
  return text.replace(/\s+/g, " ");
}

/**
 * Minimal frontmatter reader. These five files use flat `key: value` lines only, and this
 * refuses anything richer instead of mis-parsing it: a block scalar (`|`, `>`), a nested
 * mapping, or a list item would otherwise be read as a meaningless bare string. Matching
 * surrounding quotes are stripped so `model: "x"` and `model: x` compare equal.
 */
function frontmatter(text: string): Record<string, string> {
  const m = /^---\n([\s\S]*?)\n---/.exec(text);
  assert.ok(m?.[1], "missing YAML frontmatter");
  const out: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    assert.doesNotMatch(line, /^\s/, `indented frontmatter line, which this reader cannot parse: ${line}`);
    assert.doesNotMatch(line, /^-\s/, `frontmatter list item, which this reader cannot parse: ${line}`);
    const i = line.indexOf(":");
    assert.notEqual(i, -1, `frontmatter line has no key: ${line}`);
    const key = line.slice(0, i).trim();
    const raw = line.slice(i + 1).trim();
    assert.doesNotMatch(raw, /^[|>]/, `frontmatter ${key} uses a block scalar, which this reader cannot parse`);
    const quoted = raw.length >= 2 && /^(['"])[\s\S]*\1$/.test(raw);
    out[key] = quoted ? raw.slice(1, -1) : raw;
  }
  return out;
}

/**
 * Body of a Markdown section, by exact heading line, up to the next heading of the same
 * or higher level. Assertions scoped through this pin the rule the section carries rather
 * than matching an incidental occurrence of the same word in a heading or in frontmatter.
 */
function section(text: string, heading: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.trimEnd() === heading);
  assert.notEqual(start, -1, `missing section heading ${JSON.stringify(heading)}`);
  const level = /^#+/.exec(heading)?.[0].length ?? 0;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = /^(#+)\s/.exec(lines[i] ?? "");
    if (m?.[1] && m[1].length <= level) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end).join("\n");
}

/** Contents of every fenced shell block — the lines a reader is meant to actually run. */
function shellBlocks(text: string): string[] {
  return [...text.matchAll(/```(?:bash|sh|shell|console)\n([\s\S]*?)```/g)].map((m) => m[1] ?? "");
}

const skills = {
  upgrader: "skills/dotnet10-upgrader/SKILL.md",
  loop: "skills/engineering-implementation-loop/SKILL.md",
} as const;

const agents = {
  writer: "agents/lbh-dotnet10-implementation-agent.md",
  adversarial: "agents/lbh-dotnet10-adversarial-reviewer.md",
  architectural: "agents/lbh-dotnet10-architectural-reviewer.md",
} as const;

const prompts = [...Object.values(agents), ...Object.values(skills)];

const resultSchemaDoc = "skills/dotnet10-upgrader/references/result-schema.md";

describe("Cursor asset names", () => {
  it("matches folder and file conventions to frontmatter name", () => {
    const up = frontmatter(read(skills.upgrader));
    assert.equal(up.name, "dotnet10-upgrader");
    assert.equal(path.basename(path.dirname(path.join(cursor, skills.upgrader))), up.name);

    const loop = frontmatter(read(skills.loop));
    assert.equal(loop.name, "engineering-implementation-loop");
    assert.equal(path.basename(path.dirname(path.join(cursor, skills.loop))), loop.name);

    for (const rel of Object.values(agents)) {
      const fm = frontmatter(read(rel));
      assert.equal(path.basename(rel, ".md"), fm.name);
    }
  });
});

describe("skill frontmatter", () => {
  it("sets disable-model-invocation: true on both skills", () => {
    assert.equal(frontmatter(read(skills.upgrader))["disable-model-invocation"], "true");
    assert.equal(frontmatter(read(skills.loop))["disable-model-invocation"], "true");
  });
});

/**
 * Slugs Cursor's catalog accepts in agent frontmatter. An unlisted slug is not a typo that
 * degrades gracefully — Cursor refuses the launch with `Invalid model selection "..."`, so
 * what has to be pinned is membership of this list, not the spelling of any one pin.
 */
const KNOWN_MODELS = [
  "claude-opus-5-thinking-high",
  "composer-2.5-fast",
  "cursor-grok-4.6-high",
  "gpt-5.6-sol-medium",
  "muse-spark-1.3-high",
];

/** Accepts `slug` and `slug[effort=...]`; the bracket suffix is documented Cursor syntax. */
function assertKnownModel(rel: string, pin: string | undefined): void {
  assert.ok(pin, `${rel} must pin a model`);
  const slug = /^([A-Za-z0-9._-]+)(\[[^\]]+\])?$/.exec(pin)?.[1];
  assert.ok(slug, `${rel} model ${JSON.stringify(pin)} is not a slug or slug[effort=...]`);
  assert.ok(
    KNOWN_MODELS.includes(slug),
    `${rel} pins ${JSON.stringify(slug)}, which Cursor's catalog does not ship. Allowed: ${KNOWN_MODELS.join(", ")}`,
  );
}

describe("agent frontmatter", () => {
  it("pins models Cursor's catalog actually ships", () => {
    assertKnownModel(agents.writer, frontmatter(read(agents.writer)).model);
    assertKnownModel(agents.adversarial, frontmatter(read(agents.adversarial)).model);
    assertKnownModel(agents.architectural, frontmatter(read(agents.architectural)).model);
  });

  /**
   * The two reviewers read the same change set, so pinning them to one model would cost the
   * loop its second opinion: a blind spot in that model goes unchallenged.
   */
  it("keeps the two reviewers on different models", () => {
    assert.notEqual(
      frontmatter(read(agents.adversarial)).model,
      frontmatter(read(agents.architectural)).model,
    );
  });

  it("keeps reviewers read-only and the writer writable", () => {
    assert.equal(frontmatter(read(agents.writer)).readonly, "false");
    assert.equal(frontmatter(read(agents.adversarial)).readonly, "true");
    assert.equal(frontmatter(read(agents.architectural)).readonly, "true");
  });
});

type HooksConfig = {
  version: number;
  hooks: { beforeShellExecution?: { command: string; matcher: string; failClosed: boolean }[] };
};

function hooksConfig(): HooksConfig {
  return JSON.parse(read("hooks.json")) as HooksConfig;
}

/**
 * Commands the hook exists to intercept, in the spellings the prompts and a careless agent
 * actually produce. The matcher's *value* belongs to `hooks.json`; what this suite owns is
 * that whatever value is there still selects all of these.
 */
const MUTATING_SHELL_COMMANDS = [
  "git commit -m x",
  "git push",
  "git push --force origin main",
  "git reset --hard",
  "git checkout -- .",
  "git switch main",
  "git restore .",
  "git stash",
  "git rebase main",
  "git cherry-pick abc123",
  "git add -A",
  'git -C "$TARGET_REPO_PATH" commit -m x',
  "git\tcommit",
  "  git   commit -m x",
];

/** Mutating git verbs, matched against a single command line including the `-C` form. */
const MUTATING_GIT_LINE =
  /\bgit\b(?:\s+-[A-Za-z]\s+\S+)*\s+(?:commit|push|add|reset|revert|checkout|switch|restore|stash|rebase|cherry-pick)\b/;

describe("git guardrail contract", () => {
  it("registers a fail-closed beforeShellExecution hook pointing at a script on disk", () => {
    const config = hooksConfig();
    assert.equal(config.version, 1);

    const before = config.hooks.beforeShellExecution;
    assert.ok(Array.isArray(before), "hooks.beforeShellExecution must be an array");
    assert.equal(before.length, 1);

    const [hook] = before;
    assert.ok(hook, "hooks.beforeShellExecution must not be empty");
    assert.equal(hook.failClosed, true);
    assert.ok(
      fs.existsSync(path.join(root, hook.command)),
      `hook command ${hook.command} does not exist on disk`,
    );
    assert.match(hook.command, /^\.cursor\/hooks\//);
  });

  it("selects every mutating git command with the matcher as written", () => {
    const before = hooksConfig().hooks.beforeShellExecution;
    const hook = before?.[0];
    assert.ok(hook, "hooks.beforeShellExecution must not be empty");

    let matcher: RegExp;
    try {
      matcher = new RegExp(hook.matcher);
    } catch (e) {
      throw new assert.AssertionError({
        message: `hooks.json matcher ${JSON.stringify(hook.matcher)} is not a valid regular expression: ${String(e)}`,
      });
    }

    for (const command of MUTATING_SHELL_COMMANDS) {
      assert.ok(
        matcher.test(command),
        `hooks.json matcher ${JSON.stringify(hook.matcher)} does not select ${JSON.stringify(command)}, so the hook never runs for it`,
      );
    }
  });

  it("tells every agent that commit and push are forbidden and hook-enforced", () => {
    for (const rel of Object.values(agents)) {
      const text = read(rel);
      assert.match(text, /Never\*{0,2} (?:run )?`git commit`, `git push`/, `${rel} must forbid commit and push`);
      assert.match(text, /`git reset`.*`git checkout`/, `${rel} must forbid the other state-changing commands`);
      assert.match(flat(text), /A workspace hook blocks these/, `${rel} must say a hook enforces it`);
    }
  });

  it("states the ban with no exception clause carved out of it", () => {
    for (const rel of [...Object.values(agents), skills.loop]) {
      const rule = /`git commit`[\s\S]{0,500}?A workspace hook blocks these/.exec(flat(read(rel)));
      assert.ok(rule, `${rel} must ban the mutating git commands and name the hook that enforces it`);
      assert.doesNotMatch(
        rule[0] ?? "",
        /\bunless\b|\bexcept\b|\bif you need\b|\bwhen necessary\b/i,
        `${rel} carves an exception out of the mutating-git ban`,
      );
    }
  });

  it("never puts a hook-denied git command in a runnable block", () => {
    for (const rel of prompts) {
      for (const block of shellBlocks(read(rel))) {
        for (const line of block.split("\n")) {
          assert.doesNotMatch(
            line,
            MUTATING_GIT_LINE,
            `${rel} tells an agent to run a command the hook denies: ${line.trim()}`,
          );
        }
      }
    }
  });

  it("keeps the same rule in the loop skill and names the hook there too", () => {
    const text = flat(read(skills.loop));
    assert.match(text, /This loop \*\*never\*\* `git commit`s or `git push`es/);
    assert.match(text, /Never run `git commit`, `git push`/);
    assert.match(text, /A workspace hook blocks these, and a blocked command must be reported rather than worked around/);
  });
});

describe("secret handling contract", () => {
  it("forbids echoing GITHUB_TOKEN in every agent prompt and both skills", () => {
    for (const rel of prompts) {
      assert.match(
        flat(read(rel)),
        /[Nn]ever (?:echo|put) `?GITHUB_TOKEN/,
        `${rel} must forbid echoing GITHUB_TOKEN`,
      );
    }
  });
});

describe("loop skill contract", () => {
  it("scopes the fresh-writer, parallel-reviewer and clone rules to the sections that carry them", () => {
    const text = read(skills.loop);

    const freshWriter = flat(section(text, "### Launch the writer fresh every round"));
    assert.match(freshWriter, /fresh/i);
    assert.match(freshWriter, /Never resume an `lbh-dotnet10-implementation-agent`/);
    assert.match(freshWriter, /Every round gets a \*\*new\*\* Task invocation/);

    const parallelReviewers = flat(section(text, "### Launch reviewers in parallel after the writer"));
    assert.match(
      parallelReviewers,
      /launch \*\*both\*\* reviewers \*\*in a single parent message\*\*/,
      "the loop skill must require both reviewers in one parent message",
    );
    assert.match(parallelReviewers, /so they run in parallel/);
    assert.match(parallelReviewers, /Never let a reviewer run while the writer is still editing/);

    const clone = flat(section(text, "## Nested-clone adaptations (mandatory)"));
    assert.match(clone, /\*\*`TARGET_REPO_PATH`\*\* \(absolute path of the nested clone\)/);
    assert.match(clone, /\*\*`RUN_ID`\*\*/);
    assert.match(
      clone,
      /Read-only reviewers \*\*MUST NOT\*\* rerun restore\/build\/test \(`dotnet restore`, `dotnet build`, `dotnet test`\)/,
      "reviewers must be kept off commands that write bin/ and obj/",
    );

    assert.match(flat(text), /\*\*Stage 0 requires a clean prepared clone\.\*\*/);
    assert.match(flat(text), /If the working tree is dirty or has untracked files, \*\*stop\*\*\./);
    assert.match(text, /[Ff]our rounds/);
    assert.match(text, /three rounds/);
  });

  it("gates status: completed on the final round's build and test logs", () => {
    const text = flat(read(skills.loop));
    assert.match(text, /`status: completed` additionally requires/);
    assert.match(text, /final writer round's build and test logs exist under `RUN_DIR`/);
    assert.match(
      text,
      /show a passing build with no failing test that is absent from the baseline/,
      "existing logs are not enough; the loop must require them to be green",
    );
    assert.match(text, /If either log is missing/);
  });

  it("asks the writer for every field result.json needs", () => {
    const stage1 = flat(section(read(skills.loop), "## Stage 1 — Implement (writer)"));
    assert.match(
      stage1,
      /`known_limitations`, `test_changes`, `package_decisions`, `baseline_failure_names`/,
      "Stage 1 must expect package_decisions and baseline_failure_names back; the parser requires the latter",
    );
    assert.match(stage1, /`triage_decisions`/);
  });

  it("carries test_changes and package_decisions through under their camelCase keys", () => {
    const text = flat(read(skills.loop));
    assert.match(text, /Carry the last writer round's `test_changes` through to `result\.json` as `testChanges`/);
    assert.match(text, /its `package_decisions` through as `packageDecisions`/);
    assert.match(
      text,
      /\*\*rename the key\*\*/i,
      "the loop skill must say the snake_case key is renamed, not kept",
    );
  });

  it("names the round number in the handoff so $N is defined for the writer", () => {
    const text = flat(read(skills.loop));
    assert.match(
      text,
      /`ROUND_NUMBER`: the current round `N`, stated as a number/,
      "the handoff contract must carry the round number",
    );

    const stage1 = flat(section(read(skills.loop), "## Stage 1 — Implement (writer)"));
    assert.match(
      stage1,
      /State `ROUND_NUMBER` explicitly in the prompt/,
      "Stage 1 must pass the round number to the writer, which has no way to infer it",
    );
    assert.match(stage1, /\$RUN_DIR\/round-\$N-build\.log/);
    assert.match(stage1, /\$RUN_DIR\/round-\$N-test\.log/);
  });

  it("makes the adversarial reviewer's log comparison a per-round instruction", () => {
    const text = flat(read(skills.loop));
    assert.match(text, /\$RUN_DIR\/round-\$N-build\.log/);
    assert.match(text, /\$RUN_DIR\/round-\$N-test\.log/);
    assert.match(text, /read this round's two logs and compare them against `BASELINE_RESULTS`/);
    assert.match(text, /That comparison is what replaces rerunning the suite, so it happens every round/);
  });
});

const playbookStart = "Upgrade this repository to .NET 10 (LTS).";

/** The request text itself, without the wrapper prose each copy adds around it. */
function playbookBody(text: string): string {
  const start = text.indexOf(playbookStart);
  assert.ok(start >= 0, "missing the playbook request text");
  const marker = text.indexOf("UPGRADE_RESULT:", start);
  assert.ok(marker >= 0, "missing the UPGRADE_RESULT marker line");
  const eol = text.indexOf("\n", marker);
  return text.slice(start, eol === -1 ? text.length : eol);
}

describe("playbook contract", () => {
  it("keeps the reference copy and the inline copy identical", () => {
    assert.equal(
      playbookBody(read("skills/dotnet10-upgrader/references/playbook.md")),
      playbookBody(read(skills.upgrader)),
    );
  });

  it("keeps the upgrade scope rules the loop is judged against", () => {
    const playbook = playbookBody(read("skills/dotnet10-upgrader/references/playbook.md"));
    assert.match(playbook, /only where the retarget forces the move/);
    assert.match(playbook, /vulnerability advisory[\s\S]*is not a reason to move it/);
    assert.match(playbook, /Do not add a package reference the repository did not already have/);
    assert.match(playbook, /Do not suppress warnings or audit findings/);
    assert.match(playbook, /Do not delete, skip, or weaken a test to get a green build/);
    assert.match(playbook, /a test that stops running is an unreported regression/);
  });

  it("repeats those rules to the writer and makes them criticals for the adversarial reviewer", () => {
    const writer = read(agents.writer);
    assert.match(writer, /only where the retarget forces it/i);
    assert.match(writer, /Do not add a package reference the repository did not already have/);
    assert.match(writer, /Do not suppress warnings or audit findings/);
    assert.match(writer, /evidence` is mandatory/);
    assert.match(writer, /Deleting, skipping, or weakening a test is never the fix/);
    assert.match(writer, /Record every test you change in `test_changes`/);
    assert.match(writer, /^test_changes: <one entry per test file/m);
    // finalize matches entries to the diff by `file`, so the entry shape is a contract
    assert.match(writer, /^- file: <path to the test file/m);
    assert.match(writer, /^  change: <what you did to it/m);
    assert.match(writer, /^  reason: <why the upgrade required it/m);

    const adversarial = read(agents.adversarial);
    assert.match(adversarial, /the retarget did not force/);
    assert.match(adversarial, /no restore\/build error in the logs/);
    assert.match(adversarial, /new warning or audit suppression/i);
    assert.match(adversarial, /\*\*Tests weakened, deleted, or skipped\*\*/);
    assert.match(adversarial, /the writer did not record the behaviour change that justified it/);

    assert.match(read(agents.architectural), /new warning or audit suppression/i);
  });
});

describe("writer contract", () => {
  it("requires every field the parent has to forward, under the writer's own names", () => {
    const writer = read(agents.writer);
    assert.match(writer, /^changed_files: /m);
    assert.match(writer, /^implementation_summary: /m);
    assert.match(writer, /^tests_run: /m);
    assert.match(writer, /^known_limitations: /m);
    assert.match(
      writer,
      /^package_decisions: <one entry per package version you changed/m,
      "the PR body has no version rationale without this field",
    );
    assert.match(
      writer,
      /^baseline_failure_names: <fully-qualified names still failing/m,
      "result.json requires baselineFailureNames, and only the writer can produce it",
    );
  });

  it("makes the writer, and only the writer, responsible for this round's logs", () => {
    const writer = flat(read(agents.writer));
    assert.match(
      writer,
      /`dotnet build` must pass \(log `\$RUN_DIR\/round-\$N-build\.log`\)/,
      "the writer is the only agent that can create the build log the reviewer demands",
    );
    assert.match(
      writer,
      /`dotnet test` \(log `\$RUN_DIR\/round-\$N-test\.log`\)/,
      "the writer is the only agent that can create the test log the reviewer demands",
    );
  });

  it("defines $N so the writer does not guess the log filename", () => {
    const writer = flat(read(agents.writer));
    assert.match(writer, /`ROUND_NUMBER`/, "the writer must be told which variable carries the round");
    assert.match(
      writer,
      /`ROUND_NUMBER` from the prompt is the `\$N` in every `round-\$N-/,
      "$N is undefined unless the writer prompt binds it to ROUND_NUMBER",
    );
    assert.match(writer, /Never reuse an earlier round's filename and never default to `1`/);
  });

  it("names every suppression mechanism, not just the headline", () => {
    const writer = flat(read(agents.writer));
    for (const mechanism of [
      /no new `NoWarn`/,
      /no `#pragma warning disable`/,
      /no `WarningsNotAsErrors`/,
      /no `TreatWarningsAsErrors` flip/,
      /`NuGetAudit`/,
      /`NuGetAuditMode`/,
      /`NuGetAuditLevel`/,
    ]) {
      assert.match(writer, mechanism, `writer must name ${mechanism} as a forbidden suppression`);
    }
  });

  it("keeps the test-change escape hatch, and keeps the weakening ban absolute", () => {
    const writer = flat(read(agents.writer));
    assert.match(
      writer,
      /An existing test may change \*\*only\*\* where the upgrade genuinely changes the behaviour that test asserts/,
      "removing the escape hatch leaves the writer no legitimate way to record a forced test change",
    );

    const ban = /Deleting, skipping, or weakening a test is never the fix([\s\S]{0,200}?)no removing `\[Fact\]`/.exec(writer);
    assert.ok(ban, "writer must ban weakening tests and then list the mechanisms");
    assert.doesNotMatch(
      ban[1] ?? "",
      /\bexcept\b|\bunless\b|\bmay delete\b/i,
      "writer carves an exception out of the test-weakening ban",
    );
  });

  it("keeps the honest-reporting rule", () => {
    const writer = flat(read(agents.writer));
    assert.match(writer, /Never claim something works when you have not run it/);
    assert.match(writer, /Never report a test as passing that you did not see pass/);
  });

  it("scopes the no-redirection rule to repository edits, not to log capture", () => {
    const writer = flat(read(agents.writer));
    assert.match(writer, /never edit repository files via shell redirection or heredocs/);
    assert.match(
      writer,
      /persisting `dotnet --info` and the build and test logs under `\$RUN_DIR` by redirection is required/,
      "the writer cannot both be banned from redirection and required to persist logs by it",
    );
  });
});

describe("reviewer contracts", () => {
  it("makes the adversarial reviewer compare this round's logs against the baseline every round", () => {
    const text = read(agents.adversarial);
    assert.match(text, /Compare this round's logs \(mandatory, every round\)/);
    assert.match(text, /\$RUN_DIR\/round-\$N-build\.log/);
    assert.match(text, /\$RUN_DIR\/round-\$N-test\.log/);
    assert.match(text, /against `BASELINE_RESULTS` and `\$RUN_DIR\/baseline-test\.log`/);
    assert.match(text, /either log for the current round is missing/);
  });

  it("excludes build output from the staleness comparison", () => {
    const text = flat(read(agents.adversarial));
    assert.match(
      text,
      /Exclude build artefacts from that comparison/,
      "bin/ and obj/ are newer than every log in a clone that does not gitignore them",
    );
    for (const artefact of [/`bin\/`/, /`obj\/`/, /`TestResults\/`/, /`project\.assets\.json`/]) {
      assert.match(text, artefact, `staleness rule must name ${artefact} as build output`);
    }
  });

  it("keeps both reviewers off dotnet build and dotnet test", () => {
    assert.match(read(agents.adversarial), /\*\*Do not run\*\* `dotnet restore`, `dotnet build`, `dotnet test`/);
    assert.match(read(agents.architectural), /\*\*Do not run\*\* `dotnet restore`, `dotnet build`, `dotnet test`/);
  });

  it("defines the architectural reviewer's critical as a design flaw, never style", () => {
    const text = read(agents.architectural);
    assert.match(text, /`critical` means a design flaw that produces/);
    assert.match(text, /wrong behaviour or forces rework/);
    assert.match(text, /Style, naming, formatting, file/);
    assert.match(text, /it is at most a `suggestion`, and it never justifies a `FAIL`/);
  });

  it("keeps style taste out of scope for the architectural reviewer", () => {
    const outOfScope = flat(section(read(agents.architectural), "## Out of scope"));
    assert.match(
      outOfScope,
      /Do not report style taste: naming preference, formatting, file layout aesthetics/,
      "inverting this section lets a style nit FAIL the loop",
    );
    assert.match(
      outOfScope,
      /Line-level correctness, security, and test coverage belong to the adversarial reviewer, not to you/,
    );
  });

  it("routes diff_stat from the writer to both reviewers as the index of what to inspect", () => {
    const writer = read(agents.writer);
    assert.match(writer, /^diff_stat: <output of `git /m);
    assert.match(writer, /reviewers read `diff_stat` as the index of what to inspect/);

    assert.match(read(agents.adversarial), /`diff_stat` as the index of what to check/);
    assert.match(read(agents.architectural), /Read the writer's `diff_stat` against the original request/);
  });
});

describe("upgrader skill contract", () => {
  it("mentions inventory|run, prepare-repo, complete-run, finalize, result.json, and sequential batching", () => {
    const text = read(skills.upgrader);
    assert.match(text, /inventory\|run|\/dotnet10-upgrader inventory[\s\S]*\/dotnet10-upgrader run/);
    assert.match(text, /prepare-repo/);
    assert.match(text, /complete-run/);
    assert.match(text, /finalize/);
    assert.match(text, /result\.json/);
    assert.match(text, /schemaVersion|baselineFailures|reviewers|upgradeResult|unresolvedCriticals/);
    assert.match(text, /sequentially|sequential/i);
  });

  it("copies test_changes into testChanges and gates finalize on the final round's logs", () => {
    const text = read(skills.upgrader);
    assert.match(text, /Copy the last writer round's `test_changes` into `testChanges` verbatim/);
    assert.match(text, /refuses the pull request when a test file is deleted/);
    assert.match(text, /the final loop round's build and test logs exist under/);
    assert.match(text, /show a passing build with no failing test absent from the/);
  });

  it("says the snake_case key is renamed, not kept", () => {
    const text = flat(read(skills.upgrader));
    assert.match(text, /\*\*Rename the key on every one of these copies\*\*/);
    assert.match(text, /`package_decisions` → `packageDecisions`/);
    assert.match(text, /`test_changes` → `testChanges`/);
    assert.match(text, /`baseline_failure_names` → `baselineFailureNames`/);
    assert.match(
      text,
      /"Verbatim" below refers to the entries, never to the key name/,
      "'verbatim' must not be readable as an instruction to keep the snake_case key",
    );
  });
});

/** Every fenced JSON block in the result schema doc, in document order. */
function schemaDocJson(): Record<string, unknown>[] {
  const blocks = [...read(resultSchemaDoc).matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1] ?? "");
  assert.ok(blocks.length >= 2, "result-schema.md must show a clean example and a populated one");
  return blocks.map((block, i) => {
    try {
      return JSON.parse(block) as Record<string, unknown>;
    } catch (e) {
      throw new assert.AssertionError({ message: `result-schema.md json block ${i} is not valid JSON: ${String(e)}` });
    }
  });
}

describe("result schema doc contract", () => {
  it("round-trips its own clean example through the real parser", () => {
    const [clean] = schemaDocJson();
    assert.ok(clean, "result-schema.md must carry a full result.json example");
    const parsed = parseUpgradeResult(clean);
    assert.equal(isFinalizable(parsed), true, "the documented happy-path example must be finalizable");
    assert.equal(parsed.packageDecisions?.length, 1, "the example must demonstrate a packageDecisions entry");
    assert.equal(parsed.testChanges?.length, 1, "the example must demonstrate a testChanges entry");
    // The example is copied field by field by whoever writes result.json, so a count that
    // contradicts its own name list teaches the shape finalize refuses: baselineFailures > 0
    // with no names is a gate violation, and names with a zero count is a claim about
    // failures the run says it does not carry.
    assert.equal(
      parsed.baselineFailureNames.length,
      parsed.baselineFailures,
      "the example must keep baselineFailures and baselineFailureNames consistent with each other",
    );
  });

  it("round-trips a populated finding, which is what the parser is strictest about", () => {
    const [clean, populated] = schemaDocJson();
    assert.ok(clean && populated, "result-schema.md must show populated unresolvedCriticals and warnings");
    const parsed = parseUpgradeResult({ ...clean, ...populated });
    assert.ok(parsed.unresolvedCriticals.length > 0, "the populated example must carry a critical finding");
    assert.ok(parsed.warnings.length > 0, "the populated example must carry a warning finding");
    for (const finding of [...parsed.unresolvedCriticals, ...parsed.warnings]) {
      assert.ok(finding.severity, "every documented finding must carry the severity the parser requires");
      assert.ok(finding.title, "every documented finding must carry the title the parser requires");
    }
  });

  it("documents the parser rules a parent following the prose would otherwise trip on", () => {
    const doc = flat(read(resultSchemaDoc));
    assert.match(
      doc,
      /\*\*`severity` is required on every entry in both arrays\*\*/,
      "omitting severity is the single most common way a hand-written result.json is rejected",
    );
    assert.match(doc, /`"line": 12` is rejected/, "line must be documented as a string");
    assert.match(doc, /\| `title` \| string \| Required\./);
    assert.match(doc, /\| `residualRisks` \| string\[\] \|/);
    assert.match(doc, /Unknown top-level keys are accepted and silently dropped/i);
    assert.match(doc, /resolves last-wins/);
    assert.match(doc, /Rejected when empty or whitespace-only/i);
    assert.match(
      doc,
      /Required, and rejected when empty or whitespace-only\. Why the upgrade changed the behaviour/,
      "a blank testChanges.reason is rejected by the parser, not left for finalize to catch",
    );
    assert.match(
      doc,
      /reject anything outside \*\*1-50\*\*/,
      "rounds names the round whose logs the evidence gate reads, so it is range-checked",
    );
  });

  it("tells the parent to rename the writer's snake_case keys", () => {
    const doc = flat(read(resultSchemaDoc));
    assert.match(doc, /\*\*Rename the key on every copy\*\*/);
    assert.match(doc, /It never means keeping the snake_case key\./i);
    assert.match(doc, /\| `package_decisions` \| `packageDecisions` \|/);
    assert.match(doc, /\| `baseline_failure_names` \| `baselineFailureNames` \|/);
  });
});

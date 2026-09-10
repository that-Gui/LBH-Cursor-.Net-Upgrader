import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Octokit } from "@octokit/rest";
import {
  COMMIT_MESSAGE,
  finalizeRepo,
  git,
  MAX_BODY_CHARS,
  mdCode,
  mdText,
  prBody,
  readManifest,
  runDir,
  writeManifest,
  writePristineGitConfig,
  writeResult,
  type AppConfig,
} from "../src/upgrade";
import { sampleDependencies, sampleManifest, sampleResult } from "./helpers/sample-result";

const token = "ghs_finalize_test_token";
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "finalize-"));

after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function rawGit(args: string[], cwd: string): string {
  const res = spawnSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.com", ...args], {
    cwd,
    encoding: "utf8",
  });
  if (res.status !== 0) throw new Error(`raw git ${args[0]} failed: ${res.stderr}`);
  return res.stdout;
}

/** The body as GitHub would autolink it: fenced blocks and code spans render inert. */
function outsideCode(body: string): string {
  return body.replace(/^(`{3,})text\n[\s\S]*?\n\1$/gm, "[fenced summary]").replace(/`+[^`\n]*`+/g, "[code]");
}

function tableRows(body: string): string[] {
  return body.split("\n").filter((l) => l.startsWith("| ") && !l.startsWith("| :---"));
}

/** GFM splits a row on pipes that are not backslash-escaped. */
function cells(row: string): string[] {
  return row
    .split(/(?<!\\)\|/)
    .slice(1, -1)
    .map((c) => c.trim());
}

const changedPackage = sampleDependencies({
  packages: [
    { file: "src/App.csproj", package: "Newtonsoft.Json", from: "12.0.3", to: "13.0.3", kind: "changed" },
  ],
  frameworks: [{ file: "src/App.csproj", from: "net8.0", to: "net10.0", kind: "changed" }],
});

describe("mdCode / mdText", () => {
  it("wraps a value in a fence longer than any backtick run inside it", () => {
    assert.equal(mdCode("Newtonsoft.Json", token), "`Newtonsoft.Json`");
    assert.equal(mdCode("a ``b`` c", token), "```a ``b`` c```");
    assert.equal(mdCode("`quoted`", token), "`` `quoted` ``");
    assert.equal(mdCode("multi\nline", token), "`multi line`");
    assert.equal(mdCode("   ", token), "");
  });

  it("escapes pipes so a value cannot add a table cell", () => {
    assert.equal(mdCode("dotnet test | tee log", token), "`dotnet test \\| tee log`");
    assert.equal(mdText("a | b", token), "a \\| b");
  });

  it("produces well-formed entities rather than nesting its own escapes", () => {
    assert.equal(mdText("@octocat #1234", token), "&#64;octocat &#35;1234");
    assert.equal(mdText("[x](y) <b> `c`", token), "&#91;x&#93;(y) &lt;b&gt; &#96;c&#96;");
    assert.equal(mdText("&amp;", token), "&amp;amp;", "a literal entity is shown, not decoded");
    assert.equal(mdText("a\\b", token), "a\\\\b");
  });

  it("redacts the token and strips control characters via redact()", () => {
    assert.ok(!mdText(`leaked ${token}`, token).includes(token));
    assert.ok(!mdCode(`leaked ${token}`, token).includes(token));
    assert.equal(mdText("a\u001b[2Kb", token), "a&#91;2Kb");
  });

  it("clamps a runaway value", () => {
    assert.ok(mdText("x".repeat(10_000), token).length < 1_000);
    assert.ok(mdCode("x".repeat(10_000), token).length < 500);
  });
});

describe("prBody", () => {
  it("renders no <details> and shows the run summary in the body", () => {
    const body = prBody(sampleResult({ implementationSummary: "Moved TFMs." }), changedPackage, token);
    assert.ok(!body.includes("<details>"), "the run summary is no longer collapsed");
    assert.ok(!body.includes("</details>"));
    assert.ok(body.includes("### Agent run summary"));
    assert.ok(body.includes("Moved TFMs."));
  });

  it("neutralizes mentions, issue refs, links, HTML, and pipes in every agent-authored string", () => {
    const hostile = "@octocat see #1234 <img src=x onerror=1> [click](https://evil.example) a | b";
    const body = prBody(
      sampleResult({
        implementationSummary: `breakout </details>\n${hostile}`,
        residualRisks: [hostile],
        warnings: [{ severity: "warning", title: hostile, recommendation: hostile }],
        packageDecisions: [{ package: "Newtonsoft.Json", from: "12.0.3", to: "13.0.3", reason: hostile }],
      }),
      changedPackage,
      token,
    );

    const rendered = outsideCode(body);
    for (const live of ["@octocat", "#1234", "<img", "[click](", "</details>"]) {
      assert.ok(!rendered.includes(live), `${live} must not render live outside a code span`);
    }
    assert.ok(rendered.includes("&#64;octocat"), "the mention survives as inert text");
    assert.ok(rendered.includes("&#35;1234"), "the issue ref survives as inert text");
    assert.ok(rendered.includes("&lt;img"), "HTML is escaped, not dropped");
    assert.ok(rendered.includes("&#91;click&#93;"), "link syntax is neutralized");

    const rows = tableRows(body);
    assert.equal(rows.length, 2, "header plus exactly one package row");
    const row = cells(rows[1] ?? "");
    assert.equal(row.length, 5, "an unescaped pipe in the reason would split the row");
    assert.equal(row[0], "`Newtonsoft.Json`");
    assert.equal(row[1], "`12.0.3`");
    assert.equal(row[2], "`13.0.3`");
    assert.equal(row[3], "`src/App.csproj`");
    assert.ok(row[4]?.includes("&#64;octocat"));

    assert.ok(body.includes("breakout </details>"), "the verbatim summary is still quoted in full");
  });

  it("quotes the marker trailer once when the writer already wrote it", () => {
    const body = prBody(
      sampleResult({
        baselineFailures: 3,
        implementationSummary: "Bumped EF Core.\nBASELINE_FAILURES: 3\nREVIEWERS: PASS\nUPGRADE_RESULT: SUCCESS",
      }),
      changedPackage,
      token,
    );
    assert.equal(body.split("UPGRADE_RESULT:").length - 1, 1, "the trailer is not printed twice");
    assert.ok(body.includes("Bumped EF Core.\nBASELINE_FAILURES: 3\nREVIEWERS: PASS\nUPGRADE_RESULT: SUCCESS\n"));
  });

  it("uses a fence longer than any backtick run in the summary", () => {
    const body = prBody(
      sampleResult({ implementationSummary: "see ````code```` then more" }),
      changedPackage,
      token,
    );
    assert.match(body, /`````text\nsee ````code```` then more\n/);
    assert.match(body, /\n`````\n/);
  });

  it("surfaces carried failures above the fold and green-suite wording otherwise", () => {
    const green = prBody(sampleResult(), changedPackage, token);
    assert.match(green, /`dotnet build` and `dotnet test` both pass — the loop opens no PR otherwise/);
    assert.ok(!green.includes("pre-existing test failure"));

    const carried = prBody(
      sampleResult({ baselineFailures: 14, baselineFailureNames: ["Some.Flaky.Test"] }),
      changedPackage,
      token,
    );
    const fold = carried.slice(0, carried.indexOf("### Dependency and package reasoning"));
    assert.match(fold, /14 test\(s\) were already failing/);
    assert.match(carried, /The 14 pre-existing test failure\(s\) are confirmed on the base branch/);
    assert.match(carried, /Carried baseline failures \(1\)/);
    assert.ok(carried.includes("`Some.Flaky.Test`"));
  });

  it("joins diff-derived rows to the recorded reason and flags rows with none", () => {
    const body = prBody(
      sampleResult({
        packageDecisions: [
          {
            package: "newtonsoft.json",
            from: "12.0.3",
            to: "13.0.3",
            reason: "12.0.3 has no net10.0 assets",
            evidence: "first stable release targeting net10.0",
          },
        ],
      }),
      sampleDependencies({
        packages: [
          { file: "src/App.csproj", package: "Newtonsoft.Json", from: "12.0.3", to: "13.0.3", kind: "changed" },
          { file: "src/App.csproj", package: "Unexplained.Pkg", from: "1.0.0", to: "2.0.0", kind: "changed" },
        ],
      }),
      token,
    );
    assert.ok(body.includes("12.0.3 has no net10.0 assets"), "reasons join case-insensitively on package id");
    assert.ok(body.includes("(evidence: first stable release targeting net10.0)"));
    const rows = tableRows(body);
    assert.equal(rows.length, 3);
    assert.equal(cells(rows[2] ?? "")[4], "_No rationale recorded._");
  });

  it("lists decisions with no matching diff row instead of dropping them", () => {
    const body = prBody(
      sampleResult({
        packageDecisions: [
          { package: "Ghost.Package", from: "1.0.0", to: "2.0.0", reason: "claimed but not in the diff" },
        ],
      }),
      changedPackage,
      token,
    );
    assert.ok(body.includes("#### Decisions recorded with no matching change in the diff"));
    assert.ok(body.includes("`Ghost.Package`"));
    assert.ok(body.includes("claimed but not in the diff"));
  });

  it("reports framework, SDK, and base-image moves and the no-package-change case", () => {
    const body = prBody(
      sampleResult(),
      sampleDependencies({
        frameworks: [{ file: "src/App.csproj", from: "net8.0", to: "net10.0", kind: "changed" }],
        sdks: [{ file: "global.json", from: "8.0.100", to: "10.0.100", kind: "changed" }],
        images: [
          {
            file: "Dockerfile",
            image: "mcr.microsoft.com/dotnet/aspnet",
            from: "8.0",
            to: "10.0",
            kind: "changed",
          },
        ],
      }),
      token,
    );
    assert.ok(body.includes("No package versions changed; this was a target-framework-only upgrade."));
    assert.ok(body.includes("Target frameworks in `src/App.csproj`: `net8.0` → `net10.0`"));
    assert.ok(body.includes("SDK pin in `global.json`: `8.0.100` → `10.0.100`"));
    assert.ok(body.includes("Base image `mcr.microsoft.com/dotnet/aspnet` in `Dockerfile`: `8.0` → `10.0`"));
  });

  it("keeps the body under GitHub's limit for an oversized summary and table", () => {
    const packages = Array.from({ length: 200 }, (_, i) => ({
      file: "src/App.csproj",
      package: `Package.Number.${i}`,
      from: "1.0.0",
      to: "2.0.0",
      kind: "changed" as const,
    }));
    const body = prBody(
      sampleResult({
        implementationSummary: "x".repeat(300_000),
        packageDecisions: packages.map((p) => ({ package: p.package, reason: "y".repeat(2_000) })),
      }),
      sampleDependencies({ packages }),
      token,
    );
    assert.ok(body.length <= MAX_BODY_CHARS, `body was ${body.length} chars`);
    assert.ok(body.includes("### Dependency and package reasoning"));
  });

  it("redacts the token wherever it appears in agent text", () => {
    const body = prBody(
      sampleResult({
        implementationSummary: `pushed with ${token}`,
        residualRisks: [`leaked ${token}`],
        packageDecisions: [{ package: "Newtonsoft.Json", reason: `used ${token}` }],
      }),
      changedPackage,
      token,
    );
    assert.ok(!body.includes(token));
  });

  it("includes the Hackney template section markers", () => {
    const body = prBody(sampleResult(), changedPackage, token);
    for (const marker of [
      "### ` Describe this PR `",
      "### ` What is the problem we're trying to solve? `",
      "### ` What changes have we introduced? `",
      "#### ` Checklist `",
      "### ` Follow up actions after merging PR `",
    ]) {
      assert.ok(body.includes(marker), `missing ${marker}`);
    }
  });
});

type PullsMock = {
  octokit: Octokit;
  created: number;
  listed: number;
  createArgs: unknown[];
};

function mockPulls(opts: {
  create?: () => Promise<{ data: { html_url: string } }>;
  list?: () => Promise<{ data: { html_url?: string }[] }>;
}): PullsMock {
  const state: PullsMock = { octokit: {} as Octokit, created: 0, listed: 0, createArgs: [] };
  state.octokit = {
    pulls: {
      create: async (args: unknown) => {
        state.created += 1;
        state.createArgs.push(args);
        if (opts.create) return opts.create();
        return { data: { html_url: "https://github.com/LBHackney/My.Repo-1_x/pull/1" } };
      },
      list: async () => {
        state.listed += 1;
        if (opts.list) return opts.list();
        return { data: [] };
      },
    },
  } as unknown as Octokit;
  return state;
}

function csprojFixture(tfm: string, newtonsoft: string): string {
  return [
    '<Project Sdk="Microsoft.NET.Sdk">',
    `  <PropertyGroup><TargetFramework>${tfm}</TargetFramework></PropertyGroup>`,
    `  <ItemGroup><PackageReference Include="Newtonsoft.Json" Version="${newtonsoft}" /></ItemGroup>`,
    "</Project>",
    "",
  ].join("\n");
}

function setupRun(opts: {
  change?: "source" | "cursor" | "none";
  phase?: "prepared" | "loop-complete";
  result?: ReturnType<typeof sampleResult>;
}): {
  workDir: string;
  runId: string;
  cloneDir: string;
  upgradeBranch: string;
  config: AppConfig;
} {
  const workDir = fs.mkdtempSync(path.join(tmpRoot, "work-"));
  const repo = "My.Repo-1_x";
  const runId = `${repo}-20260101-120`;
  const upgradeBranch = "chore/dotnet10-upgrade-20260101-120";
  const cloneDir = path.join(workDir, "repos", repo);
  const bare = path.join(workDir, "remote.git");
  const dir = runDir(workDir, runId);

  fs.mkdirSync(cloneDir, { recursive: true, mode: 0o700 });
  rawGit(["init", "-b", "main", cloneDir], workDir);
  fs.writeFileSync(path.join(cloneDir, "App.csproj"), csprojFixture("net8.0", "12.0.3"));
  rawGit(["add", "App.csproj"], cloneDir);
  rawGit(["commit", "-m", "init"], cloneDir);
  rawGit(["checkout", "-b", upgradeBranch], cloneDir);
  const baseSha = rawGit(["rev-parse", "HEAD"], cloneDir).trim();

  if (opts.change === "cursor") {
    fs.mkdirSync(path.join(cloneDir, ".cursor"), { recursive: true });
    fs.writeFileSync(path.join(cloneDir, ".cursor", "rules.md"), "planted\n");
  } else if (opts.change !== "none") {
    fs.writeFileSync(path.join(cloneDir, "App.csproj"), csprojFixture("net10.0", "13.0.3"));
  }

  rawGit(["init", "--bare", "-b", "main", bare], workDir);

  const manifest = sampleManifest(workDir, cloneDir, {
    runId,
    phase: opts.phase ?? "loop-complete",
    repo,
    upgradeBranch,
    baseSha,
    cloneUrl: bare,
  });
  writeManifest(dir, manifest);
  writeResult(
    dir,
    sampleResult({
      ...opts.result,
      repo,
      branch: upgradeBranch,
      baseSha,
    }),
  );
  writePristineGitConfig(dir, fs.readFileSync(path.join(cloneDir, ".git", "config")));

  return {
    workDir,
    runId,
    cloneDir,
    upgradeBranch,
    config: {
      org: "LBHackney",
      token,
      workDir,
      batchSize: 4,
      activeMonths: 12,
    },
  };
}

describe("finalizeRepo", () => {
  it("commits a source change, pushes to a local bare remote, and opens a PR", async () => {
    const ctx = setupRun({
      change: "source",
      result: sampleResult({
        packageDecisions: [
          {
            package: "Newtonsoft.Json",
            from: "12.0.3",
            to: "13.0.3",
            reason: "12.0.3 does not restore against net10.0",
          },
        ],
      }),
    });
    const pulls = mockPulls({});
    const outcome = await finalizeRepo(pulls.octokit, ctx.config, ctx.runId);
    assert.equal(outcome.ok, true);
    assert.equal(outcome.prUrl, "https://github.com/LBHackney/My.Repo-1_x/pull/1");
    assert.equal(pulls.created, 1);
    assert.equal(readManifest(runDir(ctx.workDir, ctx.runId)).phase, "finalized");
    assert.equal(git(["log", "-1", "--format=%s"], ctx.cloneDir, token).trim(), COMMIT_MESSAGE);
    const remoteHeads = rawGit(["ls-remote", "--heads", path.join(ctx.workDir, "remote.git")], ctx.workDir);
    assert.ok(remoteHeads.includes(ctx.upgradeBranch));
    const createArgs = pulls.createArgs[0] as { body?: string };
    const body = createArgs.body ?? "";
    assert.ok(body.includes("### ` Describe this PR `"));
    assert.ok(
      body.includes("| `Newtonsoft.Json` | `12.0.3` | `13.0.3` | `App.csproj` | 12.0.3 does not restore against net10.0 |"),
      "the table row is derived from the staged diff and joined to the recorded reason",
    );
    assert.ok(body.includes("Target frameworks in `App.csproj`: `net8.0` → `net10.0`"));
  });

  it("adopts an existing PR after a 422", async () => {
    const ctx = setupRun({ change: "source" });
    const existing = "https://github.com/LBHackney/My.Repo-1_x/pull/9";
    const pulls = mockPulls({
      create: async () => {
        throw Object.assign(new Error("Validation Failed"), { status: 422 });
      },
      list: async () => ({ data: [{ html_url: existing }] }),
    });
    const outcome = await finalizeRepo(pulls.octokit, ctx.config, ctx.runId);
    assert.equal(outcome.ok, true);
    assert.equal(outcome.prUrl, existing);
    assert.equal(pulls.created, 1);
    assert.equal(pulls.listed, 1);
    assert.equal(readManifest(runDir(ctx.workDir, ctx.runId)).phase, "finalized");
  });

  it("refuses a forbidden .cursor path and does not call pulls.create", async () => {
    const ctx = setupRun({ change: "cursor" });
    const pulls = mockPulls({});
    const outcome = await finalizeRepo(pulls.octokit, ctx.config, ctx.runId);
    assert.equal(outcome.ok, false);
    assert.match(outcome.reason ?? "", /protected paths/);
    assert.equal(pulls.created, 0);
    assert.equal(git(["log", "-1", "--format=%s"], ctx.cloneDir, token).trim(), "init");
  });

  it("does not commit or open a PR for a non-finalizable result", async () => {
    const ctx = setupRun({
      change: "source",
      result: sampleResult({ reviewers: "FAIL", upgradeResult: "FAILED" }),
    });
    const dir = runDir(ctx.workDir, ctx.runId);
    const pulls = mockPulls({});
    const outcome = await finalizeRepo(pulls.octokit, ctx.config, ctx.runId);
    assert.equal(outcome.ok, false);
    assert.match(outcome.reason ?? "", /not finalizable/);
    assert.equal(pulls.created, 0);
    assert.equal(rawGit(["status", "--porcelain"], ctx.cloneDir).trim().length > 0, true);
    assert.equal(readManifest(dir).phase, "loop-complete");
  });

  it("refuses a clone whose .git is not a directory", async () => {
    const ctx = setupRun({ change: "source" });
    fs.rmSync(path.join(ctx.cloneDir, ".git"), { recursive: true, force: true });
    fs.writeFileSync(path.join(ctx.cloneDir, ".git"), "gitdir: /tmp/evil\n");
    const pulls = mockPulls({});
    const outcome = await finalizeRepo(pulls.octokit, ctx.config, ctx.runId);
    assert.equal(outcome.ok, false);
    assert.match(outcome.reason ?? "", /\.git is not a directory/);
    assert.equal(pulls.created, 0);
  });
});

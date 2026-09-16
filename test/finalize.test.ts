import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import type { Octokit } from "@octokit/rest";
import { MAX_DEPENDENCY_ROWS } from "../src/packages";
import {
  ARTIFACT_EXCLUDES,
  collectDependencyChanges,
  COMMIT_MESSAGE,
  finalizeRepo,
  git,
  markLoopComplete,
  MAX_BODY_CHARS,
  MAX_MANIFEST_FILES,
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
import {
  passingTestLog,
  sampleDependencies,
  sampleManifest,
  sampleResult,
  writeRoundLogs,
} from "./helpers/sample-result";

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

  it("states the upgrade scope so an unforced bump reads as out of place", () => {
    const body = prBody(sampleResult(), changedPackage, token);
    assert.ok(body.includes("a package version moves here only where the `net10.0` retarget forced it"));
  });

  it("claims what the gates check and no more", () => {
    const body = prBody(sampleResult(), changedPackage, token);
    assert.ok(
      body.includes("finalize scanned the committed diff and would have refused it outright"),
      "the claim is about what was checked, not an unconditional assertion about the diff",
    );
    assert.ok(
      !body.includes("this PR adds no warning suppressions"),
      "an unconditional claim is false whenever the scan can be bypassed",
    );
    assert.ok(
      !/otherwise weakened/.test(body),
      "the detectors do not check a gutted test body that keeps its [Fact], so nothing may claim they do",
    );
    assert.ok(
      body.includes("they do not judge whether a test that kept its `[Fact]` still asserts as much as it did"),
      "the limit of the test scan has to be stated where the claim is made",
    );
  });

  it("states where the tests stand and lists the ones the upgrade changed", () => {
    const body = prBody(
      sampleResult({
        testChanges: [
          {
            file: "Tests/App.Tests/LedgerTests.cs",
            change: "Balances now asserts the invariant-culture format",
            reason: "net10.0 ships different culture data",
          },
        ],
      }),
      changedPackage,
      token,
    );
    assert.ok(body.includes("#### Tests the upgrade changed"));
    assert.ok(
      body.includes("Every row is a change the weakening scan either found in the diff or would have refused the PR over"),
      "the list of skipped tests has to read coherently against the claim above it",
    );
    assert.ok(
      body.includes(
        "- `Tests/App.Tests/LedgerTests.cs` — Balances now asserts the invariant-culture format (net10.0 ships different culture data)",
      ),
    );
  });

  it("omits the changed-tests subsection when the run changed none", () => {
    assert.ok(!prBody(sampleResult(), changedPackage, token).includes("#### Tests the upgrade changed"));
  });

  it("lists a new package reference separately with its recorded evidence", () => {
    const body = prBody(
      sampleResult({
        packageDecisions: [
          {
            package: "System.Text.Json",
            to: "10.0.0",
            reason: "net10.0 dropped the transitive reference",
            evidence: "round-1-build.log: error CS0246",
          },
        ],
      }),
      sampleDependencies({
        packages: [{ file: "src/App.csproj", package: "System.Text.Json", to: "10.0.0", kind: "added" }],
      }),
      token,
    );
    assert.ok(body.includes("#### New package references"));
    assert.ok(
      body.includes("- `System.Text.Json` at `10.0.0` in `src/App.csproj` — required by: round-1-build.log: error CS0246"),
    );
  });

  it("marks a new reference with no recorded evidence rather than implying one", () => {
    const body = prBody(
      sampleResult(),
      sampleDependencies({
        packages: [{ file: "src/App.csproj", package: "Brand.New.Pkg", to: "1.0.0", kind: "added" }],
      }),
      token,
    );
    assert.ok(body.includes("#### New package references"));
    assert.ok(body.includes("required by: _No evidence recorded._"));
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

function csprojFixture(
  tfm: string,
  newtonsoft: string,
  opts: { noWarn?: boolean; added?: string } = {},
): string {
  const properties = [`<TargetFramework>${tfm}</TargetFramework>`];
  if (opts.noWarn) properties.push("<NoWarn>$(NoWarn);CS1591</NoWarn>");
  const packages = [`<PackageReference Include="Newtonsoft.Json" Version="${newtonsoft}" />`];
  if (opts.added) packages.push(`<PackageReference Include="${opts.added}" Version="1.0.0" />`);
  return [
    '<Project Sdk="Microsoft.NET.Sdk">',
    `  <PropertyGroup>${properties.join("")}</PropertyGroup>`,
    `  <ItemGroup>${packages.join("")}</ItemGroup>`,
    "</Project>",
    "",
  ].join("\n");
}

const TEST_FILE = "Tests/App.Tests/LedgerTests.cs";
const SOURCE_FILE = "src/Domain/Ledger.cs";
/** Nested projects, an import, an SDK pin and a Dockerfile: the layout a real repo has. */
const DOMAIN_PROJECT = "src/App.Domain/App.Domain.csproj";
const TEST_PROJECT = "Tests/App.Tests/App.Tests.csproj";

function projectFixture(tfm: string, packages: [string, string][]): string {
  return [
    '<Project Sdk="Microsoft.NET.Sdk">',
    "  <PropertyGroup>",
    `    <TargetFramework>${tfm}</TargetFramework>`,
    "  </PropertyGroup>",
    "  <ItemGroup>",
    ...packages.map(([id, v]) => `    <PackageReference Include="${id}" Version="${v}" />`),
    "  </ItemGroup>",
    "</Project>",
    "",
  ].join("\n");
}

function buildPropsFixture(): string {
  return [
    "<Project>",
    "  <PropertyGroup>",
    "    <LangVersion>latest</LangVersion>",
    "    <Nullable>enable</Nullable>",
    "    <TreatWarningsAsErrors>true</TreatWarningsAsErrors>",
    "  </PropertyGroup>",
    "</Project>",
    "",
  ].join("\n");
}

function globalJsonFixture(version: string): string {
  return `${JSON.stringify({ sdk: { version, rollForward: "latestFeature" } }, null, 2)}\n`;
}

function dockerfileFixture(tag: string): string {
  return [
    `FROM mcr.microsoft.com/dotnet/sdk:${tag} AS build`,
    "WORKDIR /src",
    "COPY . .",
    "RUN dotnet publish -c Release -o /app",
    "",
    `FROM mcr.microsoft.com/dotnet/aspnet:${tag}`,
    "WORKDIR /app",
    "COPY --from=build /app .",
    'ENTRYPOINT ["dotnet", "App.dll"]',
    "",
  ].join("\n");
}

/** The committed test class; `attribute` is the line that registers the method with the runner. */
function testFixture(attribute = "  [Fact]"): string {
  return [
    "namespace App.Tests;",
    "",
    "public class LedgerTests",
    "{",
    ...(attribute ? [attribute] : []),
    "  public void Balances() => Assert.Equal(2, 1 + 1);",
    "}",
    "",
  ].join("\n");
}

/** Production code carrying a weakening-shaped line, to show the gate reads test paths only. */
function sourceFixture(skip = false): string {
  return [
    "namespace App.Domain;",
    "",
    "public sealed class Ledger",
    "{",
    ...(skip ? ['  public const string Skip = "reserved for the ledger export";'] : []),
    "  public int Balance() => 1;",
    "}",
    "",
  ].join("\n");
}

type Change =
  | "source"
  | "cursor"
  | "github-workflow"
  | "none"
  | "suppress"
  | "added"
  | "delete-test"
  | "remove-fact"
  | "skip-fact"
  | "weaken-source"
  | "new-project"
  | "windows-artifacts"
  | "all-three";

type RunContext = {
  workDir: string;
  runId: string;
  dir: string;
  cloneDir: string;
  bare: string;
  upgradeBranch: string;
  baseSha: string;
  config: AppConfig;
};

/** The retarget every scenario shares: TFMs, the SDK pin, and the container base images. */
function retarget(cloneDir: string, newtonsoft = "13.0.3"): void {
  fs.writeFileSync(path.join(cloneDir, "App.csproj"), csprojFixture("net10.0", newtonsoft));
  fs.writeFileSync(path.join(cloneDir, DOMAIN_PROJECT), projectFixture("net10.0", [["Serilog", "2.12.0"]]));
  fs.writeFileSync(
    path.join(cloneDir, TEST_PROJECT),
    projectFixture("net10.0", [["xunit", "2.4.2"], ["Microsoft.NET.Test.Sdk", "17.6.0"]]),
  );
  fs.writeFileSync(path.join(cloneDir, "global.json"), globalJsonFixture("10.0.100"));
  fs.writeFileSync(path.join(cloneDir, "Dockerfile"), dockerfileFixture("10.0"));
}

function write(cloneDir: string, rel: string, body: string): void {
  const file = path.join(cloneDir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

function setupRun(opts: {
  change?: Change;
  phase?: "prepared" | "loop-complete";
  result?: Partial<ReturnType<typeof sampleResult>>;
  /** Commit part of the work on the branch before finalize runs, as a loop must not. */
  preCommit?: (cloneDir: string) => void;
  /** Skip the complete-run gate, leaving the phase written straight to disk. */
  forgePhase?: boolean;
  roundLogs?: { build?: string; test?: string } | false;
}): RunContext {
  const workDir = fs.mkdtempSync(path.join(tmpRoot, "work-"));
  const repo = "My.Repo-1_x";
  const runId = `${repo}-20260101-120`;
  const upgradeBranch = "chore/dotnet10-upgrade-20260101-120";
  const cloneDir = path.join(workDir, "repos", repo);
  const bare = path.join(workDir, "remote.git");
  const dir = runDir(workDir, runId);

  fs.mkdirSync(cloneDir, { recursive: true, mode: 0o700 });
  rawGit(["init", "-b", "main", cloneDir], workDir);
  write(cloneDir, "App.csproj", csprojFixture("net8.0", "12.0.3"));
  write(cloneDir, DOMAIN_PROJECT, projectFixture("net8.0", [["Serilog", "2.12.0"]]));
  write(cloneDir, TEST_PROJECT, projectFixture("net8.0", [["xunit", "2.4.2"], ["Microsoft.NET.Test.Sdk", "17.6.0"]]));
  write(cloneDir, "Directory.Build.props", buildPropsFixture());
  write(cloneDir, "global.json", globalJsonFixture("8.0.100"));
  write(cloneDir, "Dockerfile", dockerfileFixture("8.0"));
  write(cloneDir, TEST_FILE, testFixture());
  write(cloneDir, SOURCE_FILE, sourceFixture());
  rawGit(["add", "-A"], cloneDir);
  rawGit(["commit", "-m", "init"], cloneDir);
  rawGit(["checkout", "-b", upgradeBranch], cloneDir);
  const baseSha = rawGit(["rev-parse", "HEAD"], cloneDir).trim();

  if (opts.preCommit) {
    opts.preCommit(cloneDir);
    rawGit(["add", "-A"], cloneDir);
    rawGit(["commit", "-m", "wip: the loop committed, which it must not"], cloneDir);
  }

  if (opts.change === "cursor") {
    write(cloneDir, ".cursor/rules.md", "planted\n");
  } else if (opts.change === "github-workflow") {
    write(cloneDir, ".github/wörkflow.yml", "planted\n");
  } else if (opts.change === "suppress") {
    retarget(cloneDir);
    fs.writeFileSync(path.join(cloneDir, "App.csproj"), csprojFixture("net10.0", "13.0.3", { noWarn: true }));
  } else if (opts.change === "added") {
    retarget(cloneDir);
    fs.writeFileSync(
      path.join(cloneDir, "App.csproj"),
      csprojFixture("net10.0", "13.0.3", { added: "Brand.New.Pkg" }),
    );
  } else if (opts.change === "delete-test") {
    retarget(cloneDir);
    fs.rmSync(path.join(cloneDir, TEST_FILE));
  } else if (opts.change === "remove-fact") {
    retarget(cloneDir);
    write(cloneDir, TEST_FILE, testFixture(""));
  } else if (opts.change === "skip-fact") {
    retarget(cloneDir);
    write(cloneDir, TEST_FILE, testFixture('  [Fact(Skip = "net10.0 rounds the balance differently")]'));
  } else if (opts.change === "weaken-source") {
    retarget(cloneDir);
    write(cloneDir, SOURCE_FILE, sourceFixture(true));
  } else if (opts.change === "new-project") {
    retarget(cloneDir);
    write(cloneDir, "src/App.Workers/App.Workers.csproj", projectFixture("net10.0", [["Serilog", "2.12.0"]]));
    write(cloneDir, "src/App.Workers/Worker.cs", "namespace App.Workers;\npublic class Worker {}\n");
  } else if (opts.change === "windows-artifacts") {
    retarget(cloneDir);
    // Windows-cased build output the repository committed long ago, carrying a suppression.
    write(cloneDir, "Obj/Debug/Generated.cs", "#pragma warning disable CS1591\nclass Generated {}\n");
    write(cloneDir, "TESTRESULTS/run.cs", "// [Fact] removed by the runner\n");
  } else if (opts.change === "all-three") {
    retarget(cloneDir);
    fs.writeFileSync(
      path.join(cloneDir, "App.csproj"),
      csprojFixture("net10.0", "13.0.3", { noWarn: true, added: "Brand.New.Pkg" }),
    );
    fs.rmSync(path.join(cloneDir, TEST_FILE));
  } else if (opts.change !== "none") {
    retarget(cloneDir);
  }

  rawGit(["init", "--bare", "-b", "main", bare], workDir);

  const phase = opts.phase ?? "loop-complete";
  writeManifest(
    dir,
    sampleManifest(workDir, cloneDir, {
      runId,
      phase: "prepared",
      repo,
      upgradeBranch,
      baseSha,
      cloneUrl: bare,
    }),
  );
  writeResult(dir, sampleResult({ ...opts.result, repo, branch: upgradeBranch, baseSha }));
  if (opts.roundLogs !== false) writeRoundLogs(dir, opts.result?.rounds ?? 1, opts.roundLogs ?? {});
  writePristineGitConfig(dir, fs.readFileSync(path.join(cloneDir, ".git", "config")));

  if (phase === "loop-complete") {
    // The gate the operator runs between the loop and finalize; it records the digests
    // finalize re-checks. A scenario that deliberately has no evidence to gate, or a result
    // the gate would reject, writes the phase straight to disk instead — which is exactly the
    // forgery finalize has to catch on its own.
    const forge = () =>
      writeManifest(dir, { ...readManifest(dir), phase: "loop-complete" });
    if (opts.forgePhase) forge();
    else {
      try {
        markLoopComplete(workDir, runId);
      } catch {
        forge();
      }
    }
  }

  return {
    workDir,
    runId,
    dir,
    cloneDir,
    bare,
    upgradeBranch,
    baseSha,
    config: {
      org: "LBHackney",
      token,
      workDir,
      batchSize: 4,
      activeMonths: 12,
    },
  };
}

/** The tree on the branch the bare remote received, which is what a reviewer would see. */
function pushedTree(ctx: RunContext): { files: string[]; read: (file: string) => string } {
  const files = rawGit(["ls-tree", "-r", "--name-only", ctx.upgradeBranch], ctx.bare)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return {
    files,
    read: (file) => rawGit(["show", `${ctx.upgradeBranch}:${file}`], ctx.bare),
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

  it("refuses a staged warning suppression", async () => {
    const ctx = setupRun({ change: "suppress" });
    const pulls = mockPulls({});
    const outcome = await finalizeRepo(pulls.octokit, ctx.config, ctx.runId);
    assert.equal(outcome.ok, false);
    assert.match(outcome.reason ?? "", /adds warning suppressions/);
    assert.match(outcome.reason ?? "", /App\.csproj \(NoWarn\)/);
    assert.equal(pulls.created, 0);
    assert.equal(git(["log", "-1", "--format=%s"], ctx.cloneDir, token).trim(), "init");
  });

  it("refuses an added package reference with no recorded evidence", async () => {
    const ctx = setupRun({
      change: "added",
      result: sampleResult({
        packageDecisions: [{ package: "Brand.New.Pkg", to: "1.0.0", reason: "seemed useful" }],
      }),
    });
    const pulls = mockPulls({});
    const outcome = await finalizeRepo(pulls.octokit, ctx.config, ctx.runId);
    assert.equal(outcome.ok, false);
    assert.match(outcome.reason ?? "", /adds package reference\(s\) with no recorded evidence/);
    assert.match(outcome.reason ?? "", /Brand\.New\.Pkg in App\.csproj/);
    assert.equal(pulls.created, 0);
    assert.equal(git(["log", "-1", "--format=%s"], ctx.cloneDir, token).trim(), "init");
  });

  it("opens the PR when an added reference carries evidence, and lists it", async () => {
    const ctx = setupRun({
      change: "added",
      result: sampleResult({
        packageDecisions: [
          {
            package: "Brand.New.Pkg",
            to: "1.0.0",
            reason: "net10.0 moved this type out of the framework",
            evidence: "round-1-build.log: error CS0246: the type or namespace could not be found",
          },
        ],
      }),
    });
    const pulls = mockPulls({});
    const outcome = await finalizeRepo(pulls.octokit, ctx.config, ctx.runId);
    assert.equal(outcome.ok, true);
    assert.equal(pulls.created, 1);
    const body = (pulls.createArgs[0] as { body?: string }).body ?? "";
    assert.ok(body.includes("#### New package references"));
    assert.ok(body.includes("- `Brand.New.Pkg` at `1.0.0` in `App.csproj` — required by: round-1-build.log"));
  });

  it("refuses a staged diff that deletes a test file", async () => {
    const ctx = setupRun({ change: "delete-test" });
    const pulls = mockPulls({});
    const outcome = await finalizeRepo(pulls.octokit, ctx.config, ctx.runId);
    assert.equal(outcome.ok, false);
    assert.match(outcome.reason ?? "", /weakens tests with no recorded reason/);
    assert.match(outcome.reason ?? "", /Tests\/App\.Tests\/LedgerTests\.cs \(deleted test file\)/);
    assert.equal(pulls.created, 0);
    assert.equal(git(["log", "-1", "--format=%s"], ctx.cloneDir, token).trim(), "init");
  });

  it("refuses a staged diff that removes a [Fact] attribute", async () => {
    const ctx = setupRun({ change: "remove-fact" });
    const pulls = mockPulls({});
    const outcome = await finalizeRepo(pulls.octokit, ctx.config, ctx.runId);
    assert.equal(outcome.ok, false);
    assert.match(outcome.reason ?? "", /weakens tests with no recorded reason/);
    assert.match(outcome.reason ?? "", /Tests\/App\.Tests\/LedgerTests\.cs \(\[Fact\]\)/);
    assert.equal(pulls.created, 0);
  });

  it("refuses a staged diff that skips a test", async () => {
    const ctx = setupRun({ change: "skip-fact" });
    const pulls = mockPulls({});
    const outcome = await finalizeRepo(pulls.octokit, ctx.config, ctx.runId);
    assert.equal(outcome.ok, false);
    assert.match(outcome.reason ?? "", /weakens tests with no recorded reason/);
    assert.match(outcome.reason ?? "", /Tests\/App\.Tests\/LedgerTests\.cs \(Skip =\)/);
    assert.equal(pulls.created, 0);
  });

  it("opens the PR when a recorded testChanges entry names the weakened file", async () => {
    const ctx = setupRun({
      change: "skip-fact",
      result: sampleResult({
        testChanges: [
          {
            file: TEST_FILE,
            change: "Balances is skipped pending a rounding fix",
            reason: "net10.0 rounds the balance differently; the assertion pinned the old output",
          },
        ],
      }),
    });
    const pulls = mockPulls({});
    const outcome = await finalizeRepo(pulls.octokit, ctx.config, ctx.runId);
    assert.equal(outcome.ok, true);
    assert.equal(pulls.created, 1);
    const body = (pulls.createArgs[0] as { body?: string }).body ?? "";
    assert.ok(body.includes("#### Tests the upgrade changed"));
    assert.ok(
      body.includes(
        "- `Tests/App.Tests/LedgerTests.cs` — Balances is skipped pending a rounding fix (net10.0 rounds the balance differently; the assertion pinned the old output)",
      ),
    );
  });

  it("does not treat a blank reason or another file as justification", async () => {
    for (const testChanges of [
      [{ file: TEST_FILE, change: "skipped", reason: "   " }],
      [{ file: "Tests/App.Tests/OtherTests.cs", change: "skipped", reason: "unrelated" }],
    ]) {
      const ctx = setupRun({ change: "skip-fact", result: sampleResult({ testChanges }) });
      const pulls = mockPulls({});
      const outcome = await finalizeRepo(pulls.octokit, ctx.config, ctx.runId);
      assert.equal(outcome.ok, false, `justified by ${JSON.stringify(testChanges)}`);
      // A blank reason is now rejected by the parser, before it can waive anything.
      assert.match(
        outcome.reason ?? "",
        /weakens tests with no recorded reason|reason must not be empty/,
      );
      assert.equal(pulls.created, 0);
    }
  });

  it("accepts a testChanges path spelled with a leading ./", async () => {
    const ctx = setupRun({
      change: "skip-fact",
      result: sampleResult({
        testChanges: [
          {
            file: `./${TEST_FILE}`,
            change: "Balances is skipped pending a rounding fix",
            reason: "net10.0 rounds the balance differently",
          },
        ],
      }),
    });
    const pulls = mockPulls({});
    const outcome = await finalizeRepo(pulls.octokit, ctx.config, ctx.runId);
    assert.equal(outcome.ok, true, outcome.reason);
    assert.equal(pulls.created, 1);
  });

  it("does not accept a bare basename, which names a file in every test project", async () => {
    const ctx = setupRun({
      change: "skip-fact",
      result: sampleResult({
        testChanges: [
          { file: "LedgerTests.cs", change: "skipped", reason: "net10.0 rounds the balance differently" },
        ],
      }),
    });
    const pulls = mockPulls({});
    const outcome = await finalizeRepo(pulls.octokit, ctx.config, ctx.runId);
    assert.equal(outcome.ok, false);
    assert.match(outcome.reason ?? "", /weakens tests with no recorded reason/);
  });

  it("ignores a weakening-shaped line outside the test suite", async () => {
    const ctx = setupRun({ change: "weaken-source" });
    const pulls = mockPulls({});
    const outcome = await finalizeRepo(pulls.octokit, ctx.config, ctx.runId);
    assert.equal(outcome.ok, true);
    assert.equal(pulls.created, 1);
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

  it("retargets a multi-project layout, the SDK pin and the Dockerfile in one PR", async () => {
    const ctx = setupRun({ change: "source" });
    const pulls = mockPulls({});
    const outcome = await finalizeRepo(pulls.octokit, ctx.config, ctx.runId);
    assert.equal(outcome.ok, true, outcome.reason);
    const body = (pulls.createArgs[0] as { body?: string }).body ?? "";
    for (const moved of [
      "Target frameworks in `App.csproj`: `net8.0` → `net10.0`",
      "Target frameworks in `src/App.Domain/App.Domain.csproj`: `net8.0` → `net10.0`",
      "Target frameworks in `Tests/App.Tests/App.Tests.csproj`: `net8.0` → `net10.0`",
      "SDK pin in `global.json`: `8.0.100` → `10.0.100`",
      "Base image `mcr.microsoft.com/dotnet/sdk` in `Dockerfile`: `8.0` → `10.0`",
      "Base image `mcr.microsoft.com/dotnet/aspnet` in `Dockerfile`: `8.0` → `10.0`",
    ]) {
      assert.ok(body.includes(moved), `missing ${moved}`);
    }
  });

  it("refuses when HEAD has moved off baseSha, because the gates only read the index", async () => {
    const ctx = setupRun({
      change: "source",
      // Committed on the branch: a suppression, a new package and a deleted test, none of
      // which `git diff --cached` would ever show, all of which `git push branch:branch` sends.
      preCommit: (cloneDir) => {
        fs.writeFileSync(
          path.join(cloneDir, "App.csproj"),
          csprojFixture("net8.0", "12.0.3", { noWarn: true, added: "Brand.New.Pkg" }),
        );
        fs.rmSync(path.join(cloneDir, TEST_FILE));
      },
    });
    const pulls = mockPulls({});
    const outcome = await finalizeRepo(pulls.octokit, ctx.config, ctx.runId);

    assert.equal(outcome.ok, false);
    assert.match(outcome.reason ?? "", /the writer loop committed on the branch/);
    assert.match(outcome.reason ?? "", new RegExp(`records baseSha ${ctx.baseSha}`));
    assert.equal(pulls.created, 0);
    assert.equal(
      rawGit(["ls-remote", "--heads", ctx.bare], ctx.workDir).trim(),
      "",
      "nothing may reach the remote",
    );
    assert.equal(
      rawGit(["log", "-1", "--format=%s"], ctx.cloneDir).trim(),
      "wip: the loop committed, which it must not",
      "the refusal must not add a commit of its own",
    );
    assert.equal(
      rawGit(["diff", "--cached", "--name-only"], ctx.cloneDir).trim(),
      "",
      "the refusal happens before git add -A, so the index is untouched",
    );
    assert.equal(readManifest(ctx.dir).phase, "loop-complete");
  });

  it("pushes a branch a reviewer can trust: no suppression, no missing test", async () => {
    const ctx = setupRun({ change: "source" });
    const pulls = mockPulls({});
    const outcome = await finalizeRepo(pulls.octokit, ctx.config, ctx.runId);
    assert.equal(outcome.ok, true, outcome.reason);

    // Asserted on the remote, not on the outcome: whatever route a suppression or a deleted
    // test takes into the branch, this is where it would have to show up.
    const pushed = pushedTree(ctx);
    assert.ok(pushed.files.includes(TEST_FILE), "the test file must still be on the pushed branch");
    assert.ok(pushed.files.includes(TEST_PROJECT));
    for (const file of pushed.files) {
      const content = pushed.read(file);
      for (const token of ["NoWarn", "#pragma warning disable", "Skip =", "IsTestProject"]) {
        assert.ok(!content.includes(token), `${file} on the pushed branch carries ${token}`);
      }
    }
    assert.ok(pushed.read("App.csproj").includes("net10.0"), "the upgrade itself did reach the remote");
    assert.equal(
      rawGit(["rev-list", "--count", `${ctx.baseSha}..${ctx.upgradeBranch}`], ctx.bare).trim(),
      "1",
      "exactly one commit, the one the gates scanned",
    );
  });

  it("refuses a forged loop-complete manifest with no round logs", async () => {
    const ctx = setupRun({ change: "source", forgePhase: true, roundLogs: false });
    const pulls = mockPulls({});
    const outcome = await finalizeRepo(pulls.octokit, ctx.config, ctx.runId);
    assert.equal(outcome.ok, false);
    assert.match(outcome.reason ?? "", /no persisted round build\/test logs/);
    assert.equal(pulls.created, 0);
    assert.equal(rawGit(["log", "-1", "--format=%s"], ctx.cloneDir).trim(), "init");
    assert.equal(readManifest(ctx.dir).phase, "loop-complete", "the phase is not advanced to finalized");
  });

  it("refuses a forged loop-complete manifest whose round logs say the suite failed", async () => {
    const ctx = setupRun({
      change: "source",
      forgePhase: true,
      roundLogs: { test: "Failed! - Failed: 41, Passed: 0, Skipped: 0, Total: 41\n" },
    });
    const pulls = mockPulls({});
    const outcome = await finalizeRepo(pulls.octokit, ctx.config, ctx.runId);
    assert.equal(outcome.ok, false);
    assert.match(outcome.reason ?? "", /counts 41 failure\(s\)/);
    assert.equal(pulls.created, 0);
  });

  it("refuses a run whose evidence the complete-run gate never reviewed", async () => {
    const ctx = setupRun({ change: "source", forgePhase: true });
    const pulls = mockPulls({});
    const outcome = await finalizeRepo(pulls.octokit, ctx.config, ctx.runId);
    assert.equal(outcome.ok, false);
    assert.match(outcome.reason ?? "", /carries no gate digest/);
    assert.equal(pulls.created, 0);
  });

  it("refuses the waivers a result.json gained after the gate reviewed it", async () => {
    // The run is gated with no waiver in the document, exactly as the reviewer saw it.
    const ctx = setupRun({ change: "skip-fact" });
    const gated = readManifest(ctx.dir);
    assert.ok(gated.resultDigest, "the fixture must have gone through the complete-run gate");

    // Then the two fields that launder a weakened test and an unexplained package appear.
    writeResult(
      ctx.dir,
      sampleResult({
        repo: "My.Repo-1_x",
        branch: ctx.upgradeBranch,
        baseSha: ctx.baseSha,
        testChanges: [{ file: TEST_FILE, change: "skipped", reason: "appended after the gate" }],
        packageDecisions: [{ package: "Brand.New.Pkg", reason: "appended too", evidence: "none" }],
      }),
    );

    const pulls = mockPulls({});
    const outcome = await finalizeRepo(pulls.octokit, ctx.config, ctx.runId);
    assert.equal(outcome.ok, false);
    assert.match(outcome.reason ?? "", /result\.json changed after run .* was gated/);
    assert.ok((outcome.reason ?? "").includes(gated.resultDigest ?? ""), "the refusal names the gated digest");
    assert.equal(pulls.created, 0);
    assert.equal(rawGit(["log", "-1", "--format=%s"], ctx.cloneDir).trim(), "init");
  });

  it("refuses round logs rewritten after the gate read them", async () => {
    const ctx = setupRun({ change: "source" });
    writeRoundLogs(ctx.dir, 1, { test: passingTestLog(0, 99) });
    const pulls = mockPulls({});
    const outcome = await finalizeRepo(pulls.octokit, ctx.config, ctx.runId);
    assert.equal(outcome.ok, false);
    assert.match(outcome.reason ?? "", /round build\/test logs changed after run .* was gated/);
    assert.equal(pulls.created, 0);
  });

  it("names every violated gate, not just the first", async () => {
    const ctx = setupRun({ change: "all-three" });
    const pulls = mockPulls({});
    const outcome = await finalizeRepo(pulls.octokit, ctx.config, ctx.runId);
    assert.equal(outcome.ok, false);
    const reason = outcome.reason ?? "";
    assert.match(reason, /3 gate violation\(s\)/);
    assert.match(reason, /adds warning suppressions: App\.csproj \(NoWarn\)/);
    assert.match(reason, /adds package reference\(s\) with no recorded evidence: Brand\.New\.Pkg in App\.csproj/);
    assert.match(reason, /weakens tests with no recorded reason: Tests\/App\.Tests\/LedgerTests\.cs/);
    assert.equal(pulls.created, 0);
  });

  it("opens a PR for a new project and lists the references it declares", async () => {
    const ctx = setupRun({ change: "new-project" });
    const pulls = mockPulls({});
    const outcome = await finalizeRepo(pulls.octokit, ctx.config, ctx.runId);
    assert.equal(outcome.ok, true, outcome.reason);
    assert.equal(pulls.created, 1);
    const body = (pulls.createArgs[0] as { body?: string }).body ?? "";
    assert.ok(body.includes("#### References declared by project files this PR adds"));
    assert.ok(body.includes("- `Serilog` at `2.12.0` in `src/App.Workers/App.Workers.csproj`"));
    assert.ok(
      !body.includes("#### New package references"),
      "a new project's own references are not new packages in a project that already existed",
    );
  });

  it("still demands evidence for a package added to a project that already existed", async () => {
    const ctx = setupRun({ change: "added" });
    const pulls = mockPulls({});
    const outcome = await finalizeRepo(pulls.octokit, ctx.config, ctx.runId);
    assert.equal(outcome.ok, false);
    assert.match(outcome.reason ?? "", /Brand\.New\.Pkg in App\.csproj/);
  });

  it("still reads a test the base branch marked binary in .gitattributes", async () => {
    const ctx = setupRun({ change: "skip-fact" });
    // Committed on the base branch, so the gate cannot refuse it as a protected-path edit.
    // Without --text every .cs file diffs as "Binary files … differ" and the scan sees nothing.
    rawGit(["stash", "-u"], ctx.cloneDir);
    write(ctx.cloneDir, ".gitattributes", "*.cs binary\n");
    rawGit(["add", ".gitattributes"], ctx.cloneDir);
    rawGit(["commit", "--amend", "--no-edit"], ctx.cloneDir);
    rawGit(["stash", "pop"], ctx.cloneDir);
    const baseSha = rawGit(["rev-parse", "HEAD"], ctx.cloneDir).trim();
    writeResult(
      ctx.dir,
      sampleResult({ repo: "My.Repo-1_x", branch: ctx.upgradeBranch, baseSha }),
    );
    writeManifest(ctx.dir, { ...readManifest(ctx.dir), phase: "prepared", baseSha });
    markLoopComplete(ctx.workDir, ctx.runId);

    const pulls = mockPulls({});
    const outcome = await finalizeRepo(pulls.octokit, ctx.config, ctx.runId);
    assert.equal(outcome.ok, false);
    assert.match(outcome.reason ?? "", /weakens tests with no recorded reason/);
    assert.equal(pulls.created, 0);
  });

  it("ignores Windows-cased build output rather than hard-failing on it", async () => {
    const ctx = setupRun({ change: "windows-artifacts" });
    const pulls = mockPulls({});
    const outcome = await finalizeRepo(pulls.octokit, ctx.config, ctx.runId);
    assert.equal(outcome.ok, true, outcome.reason);
    assert.equal(pulls.created, 1);
  });

  it("writes the redacted log it names, on success and on refusal", async () => {
    const ok = setupRun({ change: "source" });
    const okOutcome = await finalizeRepo(mockPulls({}).octokit, ok.config, ok.runId);
    assert.equal(okOutcome.ok, true, okOutcome.reason);
    assert.equal(okOutcome.logPath, path.join(ok.workDir, "logs", "My.Repo-1_x.log"));
    const okLog = fs.readFileSync(okOutcome.logPath ?? "", "utf8");
    assert.match(okLog, /finalize run My\.Repo-1_x-20260101-120/);
    assert.match(okLog, /evidence verified/);
    assert.match(okLog, /opened https:\/\/github\.com/);
    assert.ok(!okLog.includes(token), "the log must not carry the token");

    const bad = setupRun({ change: "suppress" });
    const badOutcome = await finalizeRepo(mockPulls({}).octokit, bad.config, bad.runId);
    assert.equal(badOutcome.ok, false);
    assert.ok(badOutcome.logPath, "a failure outcome must not name a log it did not write");
    const badLog = fs.readFileSync(badOutcome.logPath ?? "", "utf8");
    assert.match(badLog, /REFUSED: refusing to open a PR, 1 gate violation/);
  });

  it("leaves the index and the exclude file as it found them when it refuses", async () => {
    const ctx = setupRun({ change: "suppress" });
    const excludeFile = path.join(ctx.cloneDir, ".git", "info", "exclude");
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const outcome = await finalizeRepo(mockPulls({}).octokit, ctx.config, ctx.runId);
      assert.equal(outcome.ok, false);
      assert.equal(
        rawGit(["diff", "--cached", "--name-only"], ctx.cloneDir).trim(),
        "",
        "a refused finalize must leave the clone as the loop left it",
      );
      assert.ok(rawGit(["status", "--porcelain"], ctx.cloneDir).trim().length > 0, "the work is still there");
    }
    const lines = fs.readFileSync(excludeFile, "utf8").split("\n").filter(Boolean);
    for (const pattern of ARTIFACT_EXCLUDES) {
      assert.equal(
        lines.filter((l) => l.trim() === pattern).length,
        1,
        `${pattern} must appear once however many times finalize ran`,
      );
    }
  });

  it("refuses a C-quoted non-ASCII .github path and does not call pulls.create", async () => {
    const ctx = setupRun({ change: "github-workflow" });
    rawGit(["add", "-A"], ctx.cloneDir);
    const listed = rawGit(["diff", "--cached", "--name-only"], ctx.cloneDir);
    assert.ok(
      listed.includes("\\") && listed.includes('"'),
      `git must C-quote the non-ASCII staged path so this test is not vacuous, got ${JSON.stringify(listed)}`,
    );
    const pulls = mockPulls({});
    const outcome = await finalizeRepo(pulls.octokit, ctx.config, ctx.runId);
    assert.equal(outcome.ok, false);
    assert.match(outcome.reason ?? "", /refusing to open a PR touching protected paths/);
    assert.ok(
      (outcome.reason ?? "").includes("wörkflow.yml"),
      `refusal must name the unquoted path, got ${JSON.stringify(outcome.reason)}`,
    );
    assert.equal(pulls.created, 0);
  });
});

describe("collectDependencyChanges", () => {
  it("refuses a diff with more manifests than it can scan instead of slicing silently", () => {
    const paths = Array.from(
      { length: MAX_MANIFEST_FILES + 1 },
      (_, i) => `aaa/Filler${String(i).padStart(4, "0")}/Filler.csproj`,
    );
    const runGit = () => "";
    assert.throws(
      () => collectDependencyChanges("/nowhere", token, [...paths, "zzz/Smuggler/Smuggler.csproj"], runGit),
      /more than the 300 this scan reads; refusing to open a PR on a partial dependency scan/,
    );
    assert.doesNotThrow(() => collectDependencyChanges("/nowhere", token, paths.slice(1), runGit));
  });

  it("refuses a diff with more dependency rows than it can scan instead of slicing silently", () => {
    const over = Array.from(
      { length: MAX_MANIFEST_FILES },
      (_, i) => `aaa/Filler${String(i).padStart(4, "0")}/Filler.csproj`,
    );
    // Same TFM on both sides so each manifest contributes exactly one added package row,
    // not a package row plus a framework row. Empty HEAD + a full projectFixture would
    // double-count and make MAX_DEPENDENCY_ROWS - 1 manifests overflow the cap too.
    const runGit = (args: string[]) =>
      (args[1] ?? "").startsWith("HEAD:")
        ? projectFixture("net10.0", [])
        : projectFixture("net10.0", [["Brand.New.Pkg", "1.0.0"]]);
    assert.throws(
      () => collectDependencyChanges("/nowhere", token, over, runGit),
      new RegExp(
        `more than the ${MAX_DEPENDENCY_ROWS} this scan reads; refusing to open a PR on a partial dependency scan`,
      ),
    );
    assert.doesNotThrow(() =>
      collectDependencyChanges("/nowhere", token, over.slice(0, MAX_DEPENDENCY_ROWS - 1), runGit),
    );
  });
});

describe("markLoopComplete", () => {
  it("hashes the same result.json bytes the gate reviewed, from a single read", () => {
    const ctx = setupRun({ phase: "prepared" });
    const original = fs.readFileSync;
    const resultReads: Buffer[] = [];
    const wrap = ((...args: Parameters<typeof original>) => {
      const filePath = args[0];
      if (typeof filePath === "string" && filePath.endsWith("result.json")) {
        if (resultReads.length >= 1) {
          const tampered = `${JSON.stringify(sampleResult({ implementationSummary: "tampered" }), null, 2)}\n`;
          const buf = Buffer.from(tampered);
          resultReads.push(buf);
          return args[1] === undefined ? buf : tampered;
        }
        const data = original.apply(fs, args);
        resultReads.push(Buffer.isBuffer(data) ? data : Buffer.from(String(data)));
        return data;
      }
      return original.apply(fs, args);
    }) as typeof original;

    try {
      fs.readFileSync = wrap;
      // upgrade.ts uses `import * as fs from "node:fs"` (the ESM namespace). Patching
      // the CJS export alone does not update that snapshot until this runs.
      syncBuiltinESMExports();
      markLoopComplete(ctx.workDir, ctx.runId);
    } finally {
      fs.readFileSync = original;
      syncBuiltinESMExports();
    }

    assert.equal(resultReads.length, 1, "the gate and the digest must share one read of result.json");
    const first = resultReads[0];
    assert.ok(first, "the intercepted read must record its bytes");
    assert.equal(readManifest(ctx.dir).resultDigest, createHash("sha256").update(first).digest("hex"));
  });
});

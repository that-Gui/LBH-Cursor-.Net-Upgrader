import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, numEnv, OperatorError, requireEnv, resolveWorkDir, type RunPhase } from "../src/upgrade";
import { sampleResult, writeRoundLogs } from "./helpers/sample-result";

const required = { GITHUB_ORG: "LBHackney", GITHUB_TOKEN: "ghs_test" };

describe("requireEnv", () => {
  it("throws when the variable is missing or blank", () => {
    assert.throws(() => requireEnv("GITHUB_TOKEN", {}), /missing required env var GITHUB_TOKEN/);
    assert.throws(() => requireEnv("GITHUB_TOKEN", { GITHUB_TOKEN: "" }), /missing required env var GITHUB_TOKEN/);
    assert.throws(() => requireEnv("GITHUB_TOKEN", { GITHUB_TOKEN: "   " }), /missing required env var GITHUB_TOKEN/);
  });
});

describe("numEnv", () => {
  it("returns the fallback when unset or blank", () => {
    assert.equal(numEnv("BATCH_SIZE", 4, {}), 4);
    assert.equal(numEnv("BATCH_SIZE", 4, { BATCH_SIZE: "" }), 4);
    assert.equal(numEnv("BATCH_SIZE", 4, { BATCH_SIZE: "  " }), 4);
  });

  it("rejects 0", () => {
    assert.throws(() => numEnv("N", 4, { N: "0" }), /invalid N: 0 \(expected an integer >= 1\)/);
  });

  it("rejects a float", () => {
    assert.throws(() => numEnv("N", 4, { N: "1.5" }), /invalid N: 1.5 \(expected an integer >= 1\)/);
  });

  it("rejects BATCH_SIZE=0", () => {
    assert.throws(
      () => numEnv("BATCH_SIZE", 4, { BATCH_SIZE: "0" }),
      /invalid BATCH_SIZE: 0 \(expected an integer >= 1\)/,
    );
    assert.throws(() => loadConfig({ ...required, BATCH_SIZE: "0" }), /invalid BATCH_SIZE: 0/);
  });
});

describe("loadConfig", () => {
  it("rejects an org outside GitHub's login charset", () => {
    assert.throws(() => loadConfig({ ...required, GITHUB_ORG: "org/name" }), /invalid GITHUB_ORG/);
    assert.throws(() => loadConfig({ ...required, GITHUB_ORG: "org.name" }), /invalid GITHUB_ORG/);
    assert.throws(() => loadConfig({ ...required, GITHUB_ORG: "org_name" }), /invalid GITHUB_ORG/);
    assert.equal(loadConfig({ ...required, GITHUB_ORG: "My-Org" }).org, "My-Org");
  });

  it("treats CODE_OWNERS=0 and unset as no filter, and keeps @org/team", () => {
    assert.equal(loadConfig(required).codeOwner, undefined);
    assert.equal(loadConfig({ ...required, CODE_OWNERS: "0" }).codeOwner, undefined);
    assert.equal(loadConfig({ ...required, CODE_OWNERS: " 0 " }).codeOwner, undefined);
    assert.equal(loadConfig({ ...required, CODE_OWNERS: "@org/team" }).codeOwner, "@org/team");
  });

  it("rejects BATCH_SIZE above the cap and a token with internal whitespace", () => {
    assert.throws(() => loadConfig({ ...required, BATCH_SIZE: "33" }), /invalid BATCH_SIZE: 33/);
    assert.throws(
      () => loadConfig({ ...required, GITHUB_TOKEN: "ghs_test token" }),
      /GITHUB_TOKEN: whitespace is not allowed/,
    );
    assert.throws(
      () => loadConfig({ ...required, CODE_OWNERS: "team\nowner" }),
      /CODE_OWNERS: control characters/,
    );
  });
});

describe("resolveWorkDir", () => {
  const cwd = "/tmp/upgrader";
  const home = "/Users/tester";

  it("refuses cwd, homedir, and the filesystem root", () => {
    assert.throws(() => resolveWorkDir(".", cwd, home), /refusing .* as WORK_DIR/);
    assert.throws(() => resolveWorkDir(cwd, cwd, home), /refusing .* as WORK_DIR/);
    assert.throws(() => resolveWorkDir(home, cwd, home), /refusing .* as WORK_DIR/);
    assert.throws(() => resolveWorkDir("/", cwd, home), /refusing .* as WORK_DIR/);
  });

  it("accepts a nested directory of its own", () => {
    assert.equal(resolveWorkDir("work", cwd, home), path.resolve(cwd, "work"));
    assert.equal(resolveWorkDir("./nested/work", cwd, home), path.resolve(cwd, "nested/work"));
  });
});

/**
 * main.ts prints a message alone or a full stack depending on whether the failure is the
 * operator's to act on, and it decides that by asking whether the error is an OperatorError.
 * Nothing else about these errors carries that meaning, so a validation path that stops throwing
 * the marker — by growing an Error subclass of its own, or a syscall-style `code` — would start
 * printing this program's internals at an operator who can do nothing with them. These cases are
 * the contract, one per rejected value.
 */
describe("environment rejections are marked as the operator's to act on", () => {
  const cwd = "/tmp/upgrader";
  const home = "/Users/tester";
  const cases: [string, () => unknown][] = [
    ["a missing GITHUB_ORG", () => loadConfig({ GITHUB_TOKEN: "ghs_test" })],
    ["a malformed GITHUB_ORG", () => loadConfig({ ...required, GITHUB_ORG: "org/name" })],
    ["a missing GITHUB_TOKEN", () => loadConfig({ GITHUB_ORG: "LBHackney" })],
    ["a whitespace GITHUB_TOKEN", () => loadConfig({ ...required, GITHUB_TOKEN: "ghs_test token" })],
    ["a blank GITHUB_TOKEN", () => requireEnv("GITHUB_TOKEN", { GITHUB_TOKEN: "   " })],
    ["a BATCH_SIZE of 0", () => loadConfig({ ...required, BATCH_SIZE: "0" })],
    ["a BATCH_SIZE above the cap", () => loadConfig({ ...required, BATCH_SIZE: "33" })],
    ["an ACTIVE_MONTHS of 0", () => loadConfig({ ...required, ACTIVE_MONTHS: "0" })],
    ["an ACTIVE_MONTHS above the cap", () => loadConfig({ ...required, ACTIVE_MONTHS: "121" })],
    ["a non-integer count", () => numEnv("BATCH_SIZE", 4, { BATCH_SIZE: "1.5" }, 1, 32)],
    ["CODE_OWNERS with control characters", () => loadConfig({ ...required, CODE_OWNERS: "team\nowner" })],
    ["cwd as WORK_DIR", () => resolveWorkDir(".", cwd, home)],
    ["the homedir as WORK_DIR", () => resolveWorkDir(home, cwd, home)],
    ["the filesystem root as WORK_DIR", () => resolveWorkDir("/", cwd, home)],
  ];

  for (const [label, reject] of cases) {
    it(`throws OperatorError for ${label}`, () => {
      assert.throws(reject, OperatorError, `${label} must be marked for the operator`);
    });
  }
});

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsx = path.join(repoRoot, "node_modules", ".bin", "tsx");

/** The CLI exits on load, so its diagnostics can only be read from a real process. */
function runCli(args: string[], env: NodeJS.ProcessEnv = {}, cwd = os.tmpdir()) {
  const res = spawnSync(tsx, [path.join(repoRoot, "src", "main.ts"), ...args], {
    cwd,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", HOME: os.homedir(), ...env },
  });
  if (res.error) throw res.error;
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

const STACK_FRAME = /^\s+at\s/m;

function makeRun(phase = "prepared"): { workDir: string; runId: string } {
  const workDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cli-diag-")), "work");
  const runId = "Fixture-20260101-120000";
  const dir = path.join(workDir, "runs", runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      runId,
      phase,
      org: "LBHackney",
      repo: "Fixture",
      defaultBranch: "main",
      upgradeBranch: "chore/dotnet10-upgrade-20260101-120000",
      cloneDir: path.join(workDir, "repos", "Fixture"),
      workDir,
      baseSha: "0".repeat(40),
      cloneUrl: "https://github.com/LBHackney/Fixture.git",
      createdAt: "2026-01-01T12:00:00.000Z",
    }),
  );
  return { workDir, runId };
}

/**
 * A run with the evidence `complete` demands already in place, so the only thing left to refuse
 * is the phase. Without the result document and the round logs, `complete` stops earlier and a
 * phase test would pass on the wrong message.
 */
function gatedRun(phase: RunPhase): { workDir: string; runId: string } {
  const { workDir, runId } = makeRun(phase);
  const dir = path.join(workDir, "runs", runId);
  const result = sampleResult({
    repo: "Fixture",
    branch: "chore/dotnet10-upgrade-20260101-120000",
    baseSha: "0".repeat(40),
  });
  fs.writeFileSync(path.join(dir, "result.json"), JSON.stringify(result));
  writeRoundLogs(dir, result.rounds);
  return { workDir, runId };
}

describe("CLI diagnostics", () => {
  it("reports a missing env var as an actionable message, not a stack trace", () => {
    const { status, stderr } = runCli(["inventory"]);
    assert.equal(status, 1, "a rejected environment exits non-zero");
    assert.match(stderr, /missing required env var GITHUB_ORG/);
    assert.doesNotMatch(stderr, STACK_FRAME, "an expected validation failure prints no stack frames");
    assert.match(stderr, /GITHUB_ORG\s+required/, "the operator is told which vars the CLI reads");
    assert.match(stderr, /WORK_DIR\s+optional/);
  });

  it("reports a rejected env var value the same way", () => {
    const { status, stderr } = runCli(["select"], { GITHUB_ORG: "org/name", GITHUB_TOKEN: "ghs_test" });
    assert.equal(status, 1);
    assert.match(stderr, /invalid GITHUB_ORG/);
    assert.doesNotMatch(stderr, STACK_FRAME);
  });

  it("keeps the stack trace for an error it does not model", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cli-diag-")), "not-a-directory");
    fs.writeFileSync(file, "");
    const { status, stderr } = runCli(["complete", "--run-id", "Fixture-20260101-120000"], { WORK_DIR: file });
    assert.equal(status, 1);
    assert.match(stderr, STACK_FRAME, "an unexpected error stays debuggable");
  });

  it("reports a missing flag with the usage text and no environment error", () => {
    const { status, stderr } = runCli(["prepare"]);
    assert.equal(status, 1);
    assert.match(stderr, /prepare requires --repo NAME/);
    assert.match(stderr, /prepare --repo NAME/, "usage names the real flag");
    assert.doesNotMatch(stderr, /missing required env var/, "the flag is reported before the environment");
    assert.doesNotMatch(stderr, STACK_FRAME);
  });

  it("prints usage on --help and exits 0", () => {
    const help = runCli(["--help"]);
    assert.equal(help.status, 0);
    for (const line of ["inventory", "select", "prepare --repo NAME", "complete --run-id ID", "finalize --run-id ID"]) {
      assert.ok(help.stdout.includes(line), `usage names ${line}`);
    }
    for (const name of ["GITHUB_ORG", "GITHUB_TOKEN", "WORK_DIR", "BATCH_SIZE", "ACTIVE_MONTHS", "CODE_OWNERS"]) {
      assert.ok(help.stdout.includes(name), `usage names ${name}`);
    }
    assert.equal(runCli(["inventory", "--help"]).status, 0, "--help never reaches GitHub");
  });

  it("reaches the run state with no GitHub credentials and reports the missing result.json", () => {
    const { workDir, runId } = makeRun();
    const { status, stderr } = runCli(["complete", "--run-id", runId], { WORK_DIR: workDir });
    assert.equal(status, 1);
    assert.doesNotMatch(stderr, /missing required env var/, "complete never calls GitHub, so it needs no token");
    assert.match(stderr, new RegExp(`run ${runId} has no result\\.json`), "the run got as far as reading its result");
    assert.match(stderr, /loop/i, "the message names the step that writes result.json");
    assert.doesNotMatch(stderr, STACK_FRAME, "a run-state failure prints no stack frames either");
  });

  it("names prepare when the run directory does not exist", () => {
    const { workDir } = makeRun();
    const { status, stderr } = runCli(["complete", "--run-id", "Nobody-20260101-120000"], { WORK_DIR: workDir });
    assert.equal(status, 1);
    assert.match(stderr, /no run Nobody-20260101-120000/);
    assert.match(stderr, /prepare --repo NAME/);
    assert.doesNotMatch(stderr, STACK_FRAME);
  });

  it("refuses a run whose phase has already moved past loop-complete, with no stack", () => {
    const { workDir, runId } = gatedRun("finalized");
    const { status, stderr } = runCli(["complete", "--run-id", runId], { WORK_DIR: workDir });
    assert.equal(status, 1);
    assert.match(
      stderr,
      /illegal phase transition: finalized -> loop-complete/,
      "the refusal names both phases, which is what the operator has to reconcile",
    );
    assert.doesNotMatch(stderr, STACK_FRAME, "a wrong-phase run is the operator's to act on, not a bug");
  });

  it("refuses a run id that could never name a run directory, with no stack", () => {
    const { workDir } = makeRun();
    const { status, stderr } = runCli(["complete", "--run-id", "../escape"], { WORK_DIR: workDir });
    assert.equal(status, 1);
    assert.match(stderr, /invalid runId: "\.\.\/escape"/);
    assert.doesNotMatch(stderr, STACK_FRAME);
  });
});

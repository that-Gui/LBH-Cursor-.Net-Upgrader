import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertResultIdentity,
  markLoopComplete,
  readManifest,
  readPristineGitConfig,
  readResult,
  roundBuildLogName,
  roundTestLogName,
  runDir,
  transitionPhase,
  verifyRoundLogs,
  writeAudit,
  writeLog,
  writeManifest,
  writePristineGitConfig,
  writeResult,
  type RunPhase,
} from "../src/upgrade";
import {
  PASSING_BUILD_LOG,
  passingTestLog,
  sampleManifest,
  sampleResult,
  writeRoundLogs,
} from "./helpers/sample-result";

function modeOf(p: string): number {
  return fs.statSync(p).mode & 0o777;
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "run-state-"));
after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("write/read roundtrip", () => {
  it("persists manifest, result, audit, git-config, and log under 0700/0600", () => {
    const workDir = fs.mkdtempSync(path.join(tmpRoot, "work-"));
    const cloneDir = path.join(workDir, "repos", "My.Repo-1_x");
    fs.mkdirSync(cloneDir, { recursive: true });
    const runId = "My.Repo-1_x-20260101-120";
    const dir = runDir(workDir, runId);
    const manifest = sampleManifest(workDir, cloneDir, { runId });
    const result = sampleResult();

    writeManifest(dir, manifest);
    writeResult(dir, result);
    writeAudit(dir, "audit line\n");
    writePristineGitConfig(dir, Buffer.from("[core]\n\trepositoryformatversion = 0\n"));
    const logFile = writeLog(workDir, manifest.repo, "helper log\n");

    assert.deepEqual(readManifest(dir), manifest);
    assert.deepEqual(readResult(dir), result);
    assert.equal(readPristineGitConfig(dir).toString(), "[core]\n\trepositoryformatversion = 0\n");
    assert.equal(fs.readFileSync(logFile, "utf8"), "helper log\n");

    assert.equal(modeOf(dir), 0o700);
    assert.equal(modeOf(path.join(dir, "manifest.json")), 0o600);
    assert.equal(modeOf(path.join(dir, "result.json")), 0o600);
    assert.equal(modeOf(path.join(dir, "audit.md")), 0o600);
    assert.equal(modeOf(path.join(dir, "git-config")), 0o600);
    assert.equal(modeOf(logFile), 0o600);
  });
});

describe("runDir", () => {
  it("rejects a runId that contains a slash or is empty", () => {
    const workDir = path.join(tmpRoot, "slash");
    assert.throws(() => runDir(workDir, "a/b"), /invalid runId/);
    assert.throws(() => runDir(workDir, "a\\b"), /invalid runId/);
    assert.throws(() => runDir(workDir, ""), /invalid runId/);
    assert.throws(() => runDir(workDir, ".."), /invalid runId/);
    assert.throws(() => runDir(workDir, "a b"), /invalid runId/);
    assert.throws(() => runDir(workDir, "run\nid"), /invalid runId/);
  });
});

describe("transitionPhase", () => {
  function seeded(phase: "prepared" | "loop-complete" | "finalized" | "failed") {
    const workDir = fs.mkdtempSync(path.join(tmpRoot, "phase-"));
    const cloneDir = path.join(workDir, "repos", "My.Repo-1_x");
    const runId = "My.Repo-1_x-20260101-120";
    const dir = runDir(workDir, runId);
    const manifest = sampleManifest(workDir, cloneDir, { runId, phase });
    writeManifest(dir, manifest);
    return manifest;
  }

  const PHASES: RunPhase[] = ["prepared", "loop-complete", "finalized", "failed"];
  /** The only transitions the run state machine allows; every other cell must throw. */
  const LEGAL: Record<RunPhase, RunPhase[]> = {
    prepared: ["loop-complete", "failed"],
    "loop-complete": ["finalized", "failed"],
    finalized: ["finalized"],
    failed: ["failed"],
  };

  it("walks the whole 4×4 matrix: every legal cell writes, every other cell throws", () => {
    for (const from of PHASES) {
      for (const to of PHASES) {
        const manifest = seeded(from);
        const dir = runDir(manifest.workDir, manifest.runId);
        if (LEGAL[from].includes(to)) {
          assert.equal(transitionPhase(manifest, to).phase, to, `${from} -> ${to}`);
          assert.equal(readManifest(dir).phase, to, `${from} -> ${to} must reach disk`);
        } else {
          assert.throws(
            () => transitionPhase(manifest, to),
            /illegal phase transition/,
            `${from} -> ${to} must be refused`,
          );
          assert.equal(readManifest(dir).phase, from, `${from} -> ${to} must leave disk alone`);
        }
      }
    }
  });

  it("refuses a stale handle rather than rewinding the phase on disk", () => {
    const stale = seeded("prepared");
    const dir = runDir(stale.workDir, stale.runId);
    // Another process completes and finalizes the run while this handle is held.
    const completed = transitionPhase(stale, "loop-complete");
    transitionPhase(completed, "finalized");
    assert.equal(readManifest(dir).phase, "finalized");

    assert.throws(
      () => transitionPhase(stale, "loop-complete"),
      /changed phase underneath this handle: it was read at prepared, the run directory now says finalized/,
    );
    assert.equal(
      readManifest(dir).phase,
      "finalized",
      "a finalized run whose PR is open must not be rewound into a second finalize",
    );
  });
});

describe("assertResultIdentity", () => {
  it("throws when repo, branch, or baseSha do not match the manifest", () => {
    const workDir = "/tmp/work-id";
    const cloneDir = "/tmp/work-id/repos/My.Repo-1_x";
    const manifest = sampleManifest(workDir, cloneDir);
    assert.throws(
      () => assertResultIdentity(manifest, sampleResult({ repo: "nope" })),
      /result identity does not match/,
    );
    assert.throws(
      () => assertResultIdentity(manifest, sampleResult({ branch: "other" })),
      /result identity does not match/,
    );
    assert.throws(
      () => assertResultIdentity(manifest, sampleResult({ baseSha: "0000" })),
      /result identity does not match/,
    );
    assert.doesNotThrow(() => assertResultIdentity(manifest, sampleResult()));
  });
});

describe("markLoopComplete", () => {
  function preparedRun(result = sampleResult(), roundLogs = true) {
    const workDir = fs.mkdtempSync(path.join(tmpRoot, "complete-"));
    const cloneDir = path.join(workDir, "repos", "My.Repo-1_x");
    const runId = "My.Repo-1_x-20260101-120";
    const dir = runDir(workDir, runId);
    writeManifest(dir, sampleManifest(workDir, cloneDir, { runId, phase: "prepared" }));
    writeResult(dir, result);
    if (roundLogs) writeRoundLogs(dir, result.rounds);
    return { workDir, runId, dir };
  }

  it("advances prepared → loop-complete when result.json is finalizable", () => {
    const { workDir, runId, dir } = preparedRun();
    const updated = markLoopComplete(workDir, runId);
    assert.equal(updated.phase, "loop-complete");
    assert.equal(readManifest(dir).phase, "loop-complete");
  });

  it("records a digest of the result.json and round logs it gated", () => {
    const { workDir, runId, dir } = preparedRun();
    const gated = markLoopComplete(workDir, runId);
    assert.match(gated.resultDigest ?? "", /^[0-9a-f]{64}$/);
    assert.match(gated.roundLogsDigest ?? "", /^[0-9a-f]{64}$/);
    assert.deepEqual(readManifest(dir), gated, "the digests must reach disk for finalize to read");

    // Re-gating after the writer produced fresh evidence rebinds the run to it.
    fs.writeFileSync(path.join(dir, roundTestLogName(1)), passingTestLog(0, 13));
    const regated = markLoopComplete(workDir, runId);
    assert.equal(regated.phase, "loop-complete");
    assert.notEqual(regated.roundLogsDigest, gated.roundLogsDigest);
  });

  it("is idempotent when already loop-complete", () => {
    const { workDir, runId } = preparedRun();
    markLoopComplete(workDir, runId);
    assert.equal(markLoopComplete(workDir, runId).phase, "loop-complete");
  });

  it("throws when the result is not finalizable, naming the field that failed", () => {
    const { workDir, runId } = preparedRun(sampleResult({ reviewers: "FAIL" }));
    assert.throws(() => markLoopComplete(workDir, runId), /not finalizable: reviewers is FAIL/);
  });

  it("throws on identity mismatch", () => {
    const { workDir, runId } = preparedRun(sampleResult({ repo: "other" }));
    assert.throws(() => markLoopComplete(workDir, runId), /result identity does not match/);
  });

  it("says the loop was supposed to write result.json rather than surfacing ENOENT", () => {
    const { workDir, runId, dir } = preparedRun();
    fs.rmSync(path.join(dir, "result.json"));
    assert.throws(
      () => markLoopComplete(workDir, runId),
      /has no result\.json in .*; the writer loop must persist its result document there/,
    );
  });

  it("refuses to advance without a persisted round build log and test log", () => {
    const { workDir, runId, dir } = preparedRun(sampleResult(), false);
    assert.throws(() => markLoopComplete(workDir, runId), /no persisted round build\/test logs/);
    assert.equal(readManifest(dir).phase, "prepared");

    fs.writeFileSync(path.join(dir, roundBuildLogName(1)), PASSING_BUILD_LOG);
    assert.throws(() => markLoopComplete(workDir, runId), /round-1-test\.log is missing/);
    assert.equal(readManifest(dir).phase, "prepared");

    fs.writeFileSync(path.join(dir, roundTestLogName(1)), passingTestLog());
    assert.equal(markLoopComplete(workDir, runId).phase, "loop-complete");
  });
});

describe("verifyRoundLogs", () => {
  /** A run directory holding whatever the caller wants the gate to find. */
  function runWith(
    seed: (dir: string) => void,
    result = sampleResult(),
  ): { dir: string; check: () => string } {
    const workDir = fs.mkdtempSync(path.join(tmpRoot, "logs-"));
    const dir = runDir(workDir, "My.Repo-1_x-20260101-120");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    seed(dir);
    return { dir, check: () => verifyRoundLogs(dir, "My.Repo-1_x-20260101-120", result) };
  }

  it("accepts real dotnet output and returns a digest over both logs", () => {
    const { check } = runWith((dir) => writeRoundLogs(dir, 1));
    assert.match(check(), /^[0-9a-f]{64}$/);
  });

  it("is stable for the same bytes and changes when a log changes", () => {
    const first = runWith((dir) => writeRoundLogs(dir, 1));
    assert.equal(first.check(), first.check());
    fs.writeFileSync(path.join(first.dir, roundBuildLogName(1)), `${PASSING_BUILD_LOG}\n`);
    assert.notEqual(first.check(), runWith((dir) => writeRoundLogs(dir, 1)).check());
  });

  it("refuses zero-byte logs", () => {
    const { check } = runWith((dir) => {
      fs.writeFileSync(path.join(dir, roundBuildLogName(1)), "");
      fs.writeFileSync(path.join(dir, roundTestLogName(1)), "");
    });
    assert.throws(check, /round-1-build\.log is empty/);
  });

  it("refuses a log that is a directory", () => {
    const { check } = runWith((dir) => {
      fs.mkdirSync(path.join(dir, roundBuildLogName(1)));
      fs.mkdirSync(path.join(dir, roundTestLogName(1)));
    });
    assert.throws(check, /round-1-build\.log is not a regular file/);
  });

  it("refuses a dangling symlink and a symlink to a green log outside the run directory", () => {
    const dangling = runWith((dir) => {
      fs.symlinkSync(path.join(dir, "nowhere.log"), path.join(dir, roundBuildLogName(1)));
      fs.symlinkSync(path.join(dir, "nowhere.log"), path.join(dir, roundTestLogName(1)));
    });
    assert.throws(dangling.check, /round-1-build\.log is a symlink/);

    const outside = fs.mkdtempSync(path.join(tmpRoot, "outside-logs-"));
    fs.writeFileSync(path.join(outside, "green-build.log"), PASSING_BUILD_LOG);
    fs.writeFileSync(path.join(outside, "green-test.log"), passingTestLog());
    const linked = runWith((dir) => {
      fs.symlinkSync(path.join(outside, "green-build.log"), path.join(dir, roundBuildLogName(1)));
      fs.symlinkSync(path.join(outside, "green-test.log"), path.join(dir, roundTestLogName(1)));
    });
    assert.throws(linked.check, /round-1-build\.log is a symlink/);
  });

  it("refuses a failed build and a log carrying no verdict at all", () => {
    const failedBuild = runWith((dir) =>
      writeRoundLogs(dir, 1, { build: "Build FAILED.\n  12 Error(s)\n" }),
    );
    assert.throws(failedBuild.check, /round-1-build\.log says the build FAILED/);

    const newLogger = runWith((dir) =>
      writeRoundLogs(dir, 1, { build: "Build failed with 2 error(s) in 3.1s\n" }),
    );
    assert.throws(newLogger.check, /says the build FAILED/);

    const noVerdict = runWith((dir) =>
      writeRoundLogs(dir, 1, { build: "Determining projects to restore...\nRestored App.csproj.\n" }),
    );
    assert.throws(noVerdict.check, /no build verdict for round 1/);
  });

  it("refuses a test log whose contents say the suite failed", () => {
    const { check } = runWith((dir) =>
      writeRoundLogs(dir, 1, { test: "Failed! - Failed: 41, Passed: 0, Skipped: 0, Total: 41\n" }),
    );
    assert.throws(check, /counts 41 failure\(s\), result\.json records baselineFailures=0/);
  });

  it("allows failures up to the recorded baseline and no further", () => {
    const carried = sampleResult({ baselineFailures: 3, baselineFailureNames: ["A", "B", "C"] });
    const atBaseline = runWith((dir) => writeRoundLogs(dir, 1, { test: passingTestLog(3, 20) }), carried);
    assert.match(atBaseline.check(), /^[0-9a-f]{64}$/);

    const overBaseline = runWith((dir) => writeRoundLogs(dir, 1, { test: passingTestLog(4, 20) }), carried);
    assert.throws(overBaseline.check, /counts 4 failure\(s\), result\.json records baselineFailures=3/);
  });

  it("refuses a test log with no verdict, and one that cannot be counted", () => {
    const silent = runWith((dir) =>
      writeRoundLogs(dir, 1, { test: "Starting test execution, please wait...\n" }),
    );
    assert.throws(silent.check, /no test verdict for round 1/);

    const uncountable = runWith((dir) =>
      writeRoundLogs(dir, 1, { test: "Test Run Failed.\nsee the trx for details\n" }),
    );
    assert.throws(uncountable.check, /carries no "Failed: N" count/);
  });

  it("reads the logs for the round the result claims, not whichever round is on disk", () => {
    const threeRounds = sampleResult({ rounds: 3 });
    const { check } = runWith((dir) => writeRoundLogs(dir, 1), threeRounds);
    assert.throws(check, /round-3-build\.log is missing/);

    const matching = runWith((dir) => writeRoundLogs(dir, 3), threeRounds);
    assert.match(matching.check(), /^[0-9a-f]{64}$/);
  });

  it("tells the writer what the log has to contain", () => {
    const { check } = runWith((dir) => writeRoundLogs(dir, 1, { build: "nothing useful\n" }));
    assert.throws(check, (e: Error) => {
      assert.ok(e.message.includes("round-1-build.log"), "names the file");
      assert.ok(e.message.includes("Build succeeded"), "names the build verdict it looks for");
      assert.ok(e.message.includes("Passed!"), "names the test verdict it looks for");
      assert.ok(e.message.includes("baselineFailures"), "names the failure budget");
      return true;
    });
  });
});

describe("manifest bounds", () => {
  it("rejects a cloneDir outside workDir/repos/<repo>", () => {
    const workDir = fs.mkdtempSync(path.join(tmpRoot, "bounds-"));
    const runId = "My.Repo-1_x-20260101-120";
    const dir = runDir(workDir, runId);
    const outside = fs.mkdtempSync(path.join(tmpRoot, "outside-"));
    writeManifest(dir, sampleManifest(workDir, outside, { runId }));
    assert.throws(() => readManifest(dir), /cloneDir must be/);
  });

  it("rejects a cloneUrl that looks like a git option or ext protocol", () => {
    const workDir = fs.mkdtempSync(path.join(tmpRoot, "url-"));
    const cloneDir = path.join(workDir, "repos", "My.Repo-1_x");
    const runId = "My.Repo-1_x-20260101-120";
    const dir = runDir(workDir, runId);
    writeManifest(
      dir,
      sampleManifest(workDir, cloneDir, { runId, cloneUrl: "--upload-pack=evil" }),
    );
    assert.throws(() => readManifest(dir), /cloneUrl/);
    writeManifest(
      dir,
      sampleManifest(workDir, cloneDir, { runId, cloneUrl: "ext::sh -c evil" }),
    );
    assert.throws(() => readManifest(dir), /cloneUrl/);
  });

  it("rejects an upgradeBranch that could be parsed as a git flag", () => {
    const workDir = fs.mkdtempSync(path.join(tmpRoot, "branch-"));
    const cloneDir = path.join(workDir, "repos", "My.Repo-1_x");
    const runId = "My.Repo-1_x-20260101-120";
    const dir = runDir(workDir, runId);
    writeManifest(
      dir,
      sampleManifest(workDir, cloneDir, {
        runId,
        upgradeBranch: "--output=/tmp/pwned",
      }),
    );
    assert.throws(() => readManifest(dir), /upgradeBranch is invalid/);
  });

  it("rejects a cloneDir that is a symlink out of workDir", () => {
    const workDir = fs.mkdtempSync(path.join(tmpRoot, "symlink-"));
    const cloneDir = path.join(workDir, "repos", "My.Repo-1_x");
    const runId = "My.Repo-1_x-20260101-120";
    const dir = runDir(workDir, runId);
    fs.mkdirSync(path.dirname(cloneDir), { recursive: true });
    const outside = fs.mkdtempSync(path.join(tmpRoot, "link-target-"));
    fs.symlinkSync(outside, cloneDir);
    writeManifest(dir, sampleManifest(workDir, cloneDir, { runId }));
    assert.throws(() => readManifest(dir), /outside the expected repo directory/);
  });
});

describe("writeLog", () => {
  it("uses 0600 and cannot follow a pre-planted symlink (rm + wx)", () => {
    const workDir = fs.mkdtempSync(path.join(tmpRoot, "log-"));
    const victim = path.join(workDir, "victim.txt");
    fs.writeFileSync(victim, "untouched\n", { mode: 0o600 });
    const logsDir = path.join(workDir, "logs");
    fs.mkdirSync(logsDir, { recursive: true, mode: 0o700 });
    const logFile = path.join(logsDir, "My.Repo-1_x.log");
    fs.symlinkSync(victim, logFile);

    const written = writeLog(workDir, "My.Repo-1_x", "safe log\n");
    assert.equal(written, logFile);
    assert.equal(fs.lstatSync(logFile).isSymbolicLink(), false);
    assert.equal(fs.readFileSync(logFile, "utf8"), "safe log\n");
    assert.equal(fs.readFileSync(victim, "utf8"), "untouched\n");
    assert.equal(modeOf(logFile), 0o600);
  });

  it("rejects a repo name that is not REPO_NAME-safe", () => {
    const workDir = fs.mkdtempSync(path.join(tmpRoot, "badlog-"));
    assert.throws(() => writeLog(workDir, "../evil", "x"), /unexpected repo name/);
    assert.throws(() => writeLog(workDir, "a/b", "x"), /unexpected repo name/);
  });
});

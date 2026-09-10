import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isFinalizable,
  parseMarkers,
  parseUpgradeResult,
  summaryText,
  validateResult,
} from "../src/upgrade";
import { sampleResult } from "./helpers/sample-result";

describe("parseMarkers", () => {
  it("accepts green SUCCESS with trailing whitespace and blank lines", () => {
    const summary = [
      "Moved TFMs to net10.0.",
      "BASELINE_FAILURES: 0",
      "REVIEWERS: PASS",
      "UPGRADE_RESULT: SUCCESS",
      "  ",
      "",
      "\t",
    ].join("\n");
    assert.deepEqual(parseMarkers(summary), { ok: true, baselineFailures: 0 });
  });

  it("accepts carried BASELINE_FAILURES: 14", () => {
    const summary = [
      "Carrying 14 pre-existing failures.",
      "BASELINE_FAILURES: 14",
      "REVIEWERS: PASS",
      "UPGRADE_RESULT: SUCCESS",
    ].join("\n");
    assert.deepEqual(parseMarkers(summary), { ok: true, baselineFailures: 14 });
  });

  it("fails when SUCCESS is followed by FAILED in the last three lines", () => {
    const summary = [
      "BASELINE_FAILURES: 0",
      "REVIEWERS: PASS",
      "UPGRADE_RESULT: SUCCESS",
      "UPGRADE_RESULT: FAILED",
    ].join("\n");
    const verdict = parseMarkers(summary);
    assert.equal(verdict.ok, false);
    if (!verdict.ok) assert.match(verdict.reason, /UPGRADE_RESULT: SUCCESS/);
  });

  it("fails on REVIEWERS: FAIL even if UPGRADE_RESULT is SUCCESS", () => {
    const summary = [
      "BASELINE_FAILURES: 0",
      "REVIEWERS: FAIL",
      "UPGRADE_RESULT: SUCCESS",
    ].join("\n");
    const verdict = parseMarkers(summary);
    assert.equal(verdict.ok, false);
    if (!verdict.ok) assert.match(verdict.reason, /REVIEWERS: PASS/);
  });

  it("fails when BASELINE_FAILURES is missing", () => {
    const summary = ["Moved TFMs to net10.0.", "REVIEWERS: PASS", "UPGRADE_RESULT: SUCCESS"].join("\n");
    const verdict = parseMarkers(summary);
    assert.equal(verdict.ok, false);
    if (!verdict.ok) assert.match(verdict.reason, /BASELINE_FAILURES/);
  });

  it("fails when REVIEWERS is missing", () => {
    const summary = ["BASELINE_FAILURES: 0", "UPGRADE_RESULT: SUCCESS"].join("\n");
    const verdict = parseMarkers(summary);
    assert.equal(verdict.ok, false);
  });

  it("fails on a non-numeric baseline count", () => {
    const summary = [
      "BASELINE_FAILURES: fourteen",
      "REVIEWERS: PASS",
      "UPGRADE_RESULT: SUCCESS",
    ].join("\n");
    const verdict = parseMarkers(summary);
    assert.equal(verdict.ok, false);
    if (!verdict.ok) assert.match(verdict.reason, /BASELINE_FAILURES/);
  });

  it("fails on empty input", () => {
    const verdict = parseMarkers("");
    assert.equal(verdict.ok, false);
  });

  it("fails when narration mentions SUCCESS without marker lines", () => {
    const verdict = parseMarkers("the upgrade was a SUCCESS and reviewers said PASS");
    assert.equal(verdict.ok, false);
    if (!verdict.ok) assert.match(verdict.reason, /UPGRADE_RESULT: SUCCESS/);
  });
});

describe("isFinalizable", () => {
  it("requires PASS, SUCCESS, buildPassed, no regression, and empty unresolvedCriticals", () => {
    assert.equal(isFinalizable(sampleResult()), true);
    assert.equal(isFinalizable(sampleResult({ reviewers: "FAIL" })), false);
    assert.equal(isFinalizable(sampleResult({ upgradeResult: "FAILED" })), false);
    assert.equal(isFinalizable(sampleResult({ buildPassed: false })), false);
    assert.equal(isFinalizable(sampleResult({ testsRegressed: true })), false);
    assert.equal(
      isFinalizable(
        sampleResult({
          unresolvedCriticals: [{ severity: "critical", title: "leftover net8 TFM" }],
        }),
      ),
      false,
    );
  });
});

describe("validateResult", () => {
  const expected = {
    repo: "My.Repo-1_x",
    branch: "chore/dotnet10-upgrade-20260101-120",
    baseSha: "abc123def456",
  };

  it("returns the parsed result when identity matches", () => {
    assert.deepEqual(validateResult(sampleResult(), expected), sampleResult());
  });

  it("rejects repo, branch, or baseSha mismatch", () => {
    assert.throws(
      () => validateResult(sampleResult({ repo: "other" }), expected),
      /identity mismatch/,
    );
    assert.throws(
      () => validateResult(sampleResult({ branch: "wrong" }), expected),
      /identity mismatch/,
    );
    assert.throws(
      () => validateResult(sampleResult({ baseSha: "deadbeef" }), expected),
      /identity mismatch/,
    );
  });
});

describe("parseUpgradeResult / summaryText", () => {
  it("round-trips testsRun as string[]", () => {
    const parsed = parseUpgradeResult(sampleResult({ testsRun: ["dotnet test — 14 failed"] }));
    assert.deepEqual(parsed.testsRun, ["dotnet test — 14 failed"]);
  });

  it("rejects object-shaped testsRun", () => {
    assert.throws(
      () =>
        parseUpgradeResult({
          ...sampleResult(),
          testsRun: [{ command: "dotnet test", result: "passed" }],
        }),
      /testsRun must be an array of strings/,
    );
  });

  it("emits the three marker lines after the summary", () => {
    const text = summaryText(sampleResult({ baselineFailures: 2 }));
    assert.ok(text.endsWith("BASELINE_FAILURES: 2\nREVIEWERS: PASS\nUPGRADE_RESULT: SUCCESS"));
  });
});

describe("summaryText marker trailer", () => {
  const conforming = [
    "Moved all TFMs to net10.0 and bumped EF Core.",
    "BASELINE_FAILURES: 3",
    "REVIEWERS: PASS",
    "UPGRADE_RESULT: SUCCESS",
  ].join("\n");

  it("does not repeat a trailer the writer already wrote", () => {
    const text = summaryText(sampleResult({ implementationSummary: conforming, baselineFailures: 3 }));
    assert.equal(text, conforming);
    for (const marker of ["BASELINE_FAILURES:", "REVIEWERS:", "UPGRADE_RESULT:"]) {
      assert.equal(text.split(marker).length - 1, 1, `${marker} must appear exactly once`);
    }
    assert.deepEqual(parseMarkers(text), { ok: true, baselineFailures: 3 });
  });

  it("replaces a writer trailer that disagrees with the parent's values", () => {
    const stale = [
      "Bumped EF Core.",
      "BASELINE_FAILURES: 0",
      "REVIEWERS: FAIL",
      "UPGRADE_RESULT: FAILED",
    ].join("\n");
    const text = summaryText(sampleResult({ implementationSummary: stale, baselineFailures: 3 }));
    assert.equal(text, "Bumped EF Core.\nBASELINE_FAILURES: 3\nREVIEWERS: PASS\nUPGRADE_RESULT: SUCCESS");
    assert.ok(!text.includes("REVIEWERS: FAIL"), "the stale verdict must not survive");
    assert.ok(!text.includes("UPGRADE_RESULT: FAILED"));
    assert.ok(!text.includes("BASELINE_FAILURES: 0"));
    assert.deepEqual(parseMarkers(text), { ok: true, baselineFailures: 3 });
  });

  it("ignores blank and whitespace-only lines around the trailer", () => {
    const padded = `Bumped EF Core.\n\nBASELINE_FAILURES: 3\n  \nREVIEWERS: PASS\n\nUPGRADE_RESULT: SUCCESS\n\n  \n`;
    const text = summaryText(sampleResult({ implementationSummary: padded, baselineFailures: 3 }));
    assert.equal(text, "Bumped EF Core.\nBASELINE_FAILURES: 3\nREVIEWERS: PASS\nUPGRADE_RESULT: SUCCESS");
  });

  it("keeps a summary that is nothing but a trailer down to one copy", () => {
    const text = summaryText(sampleResult({ implementationSummary: conforming.split("\n").slice(1).join("\n"), baselineFailures: 3 }));
    assert.equal(text, "BASELINE_FAILURES: 3\nREVIEWERS: PASS\nUPGRADE_RESULT: SUCCESS");
  });

  it("leaves prose alone when the last lines are not a marker trailer", () => {
    for (const summary of [
      "REVIEWERS: PASS was reported mid-run, then we bumped EF Core.",
      "UPGRADE_RESULT: SUCCESS is what the writer claimed but it kept working",
      "BASELINE_FAILURES: 3\nREVIEWERS: PASS\nthen one more fix landed",
    ]) {
      const text = summaryText(sampleResult({ implementationSummary: summary, baselineFailures: 3 }));
      assert.ok(
        text.startsWith(summary),
        `body must be preserved verbatim, got ${JSON.stringify(text)}`,
      );
      assert.ok(text.endsWith("BASELINE_FAILURES: 3\nREVIEWERS: PASS\nUPGRADE_RESULT: SUCCESS"));
    }
  });
});

describe("packageDecisions", () => {
  const decision = {
    package: "Microsoft.EntityFrameworkCore",
    from: "8.0.4",
    to: "10.0.0",
    reason: "8.0.4 has no net10.0-compatible assets",
    evidence: "first stable release with a net10.0 target",
  };

  it("round-trips a full entry", () => {
    const parsed = parseUpgradeResult(sampleResult({ packageDecisions: [decision] }));
    assert.deepEqual(parsed.packageDecisions, [decision]);
  });

  it("keeps optional from/to/evidence absent rather than undefined", () => {
    const parsed = parseUpgradeResult(
      sampleResult({ packageDecisions: [{ package: "Serilog", reason: "pinned by the new SDK" }] }),
    );
    assert.deepEqual(parsed.packageDecisions, [{ package: "Serilog", reason: "pinned by the new SDK" }]);
  });

  it("defaults to [] when the field is absent, so schemaVersion 1 results still validate", () => {
    const { packageDecisions, ...withoutField } = sampleResult();
    assert.equal(packageDecisions?.length, 0);
    assert.deepEqual(parseUpgradeResult(withoutField).packageDecisions, []);
    assert.equal(isFinalizable(parseUpgradeResult(withoutField)), true);
  });

  it("rejects malformed entries", () => {
    const withDecisions = (packageDecisions: unknown) => () =>
      parseUpgradeResult({ ...sampleResult(), packageDecisions });
    assert.throws(withDecisions("Newtonsoft.Json"), /packageDecisions must be an array/);
    assert.throws(withDecisions(["Newtonsoft.Json"]), /packageDecisions\[0\] must be an object/);
    assert.throws(withDecisions([{ reason: "no package id" }]), /package must be a string/);
    assert.throws(withDecisions([{ package: " ", reason: "blank id" }]), /package must not be empty/);
    assert.throws(withDecisions([{ package: "Serilog" }]), /reason must be a string/);
    assert.throws(withDecisions([{ package: "Serilog", reason: "" }]), /reason must not be empty/);
    assert.throws(withDecisions([{ package: "Serilog", reason: "ok", from: 8 }]), /from must be a string/);
  });
});

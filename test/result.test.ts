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

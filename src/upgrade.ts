import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { retry } from "@octokit/plugin-retry";
import { throttling } from "@octokit/plugin-throttling";
import { Octokit } from "@octokit/rest";
import type { RepoReport } from "./inventory";
import {
  capDependencyChanges,
  diffManifests,
  emptyDependencyChanges,
  findSuppressions,
  findTestWeakening,
  hasDependencyChanges,
  isPackageManifest,
  MAX_DEPENDENCY_ROWS,
  mergeDependencyChanges,
  unquoteGitPath,
  type DependencyChanges,
  type PackageChange,
  type Suppression,
  type TestWeakening,
} from "./packages";

export type AppConfig = {
  org: string;
  token: string;
  workDir: string;
  batchSize: number;
  activeMonths: number;
  codeOwner?: string;
};

/**
 * A failure the operator is the one to act on: a rejected environment variable, a run id that
 * names no run, a run directory whose contents are not what the next step needs. Its message is
 * written for whoever ran the command — it names the value that was rejected and, where there is
 * one, the step that would fix it — and its stack says nothing an operator can use, so the CLI
 * prints the message alone and must never print it with a stack.
 *
 * Throw a plain `Error` instead when the stack is the only thing that locates the problem: an
 * invariant this program is supposed to maintain, or a bug in it. The test is whether the message
 * would help someone with no access to this source; if it would not, it is not an OperatorError.
 */
export class OperatorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OperatorError";
  }
}

export function requireEnv(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const v = env[name]?.trim();
  if (!v) throw new OperatorError(`missing required env var ${name}`);
  return v;
}

export function numEnv(
  name: string,
  fallback: number,
  env: NodeJS.ProcessEnv = process.env,
  min = 1,
  max = Number.MAX_SAFE_INTEGER,
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  const bounded = max < Number.MAX_SAFE_INTEGER;
  if (!Number.isInteger(n) || n < min || n > max) {
    const range = bounded ? `>= ${min} and <= ${max}` : `>= ${min}`;
    throw new OperatorError(`invalid ${name}: ${raw} (expected an integer ${range})`);
  }
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const org = requireEnv("GITHUB_ORG", env);
  if (!ORG_NAME.test(org)) {
    throw new OperatorError(`invalid GITHUB_ORG: ${JSON.stringify(org)}`);
  }
  const token = requireEnv("GITHUB_TOKEN", env);
  if (/\s/.test(token)) {
    throw new OperatorError("invalid GITHUB_TOKEN: whitespace is not allowed");
  }
  const rawOwner = env.CODE_OWNERS?.trim();
  const codeOwner = !rawOwner || rawOwner === "0" ? undefined : rawOwner;
  if (codeOwner && /[\0\r\n]/.test(codeOwner)) {
    throw new OperatorError("invalid CODE_OWNERS: control characters are not allowed");
  }
  const batchSize = numEnv("BATCH_SIZE", 4, env, 1, 32);
  return {
    org,
    token,
    workDir: env.WORK_DIR?.trim() || "./work",
    batchSize,
    activeMonths: numEnv("ACTIVE_MONTHS", 12, env, 1, 120),
    codeOwner,
  };
}

export function resolveWorkDir(workDir: string, cwd = process.cwd(), homedir = os.homedir()): string {
  const resolved = path.resolve(cwd, workDir);
  if (resolved === path.parse(resolved).root || resolved === cwd || resolved === homedir) {
    throw new OperatorError(`refusing ${resolved} as WORK_DIR: pick a directory of its own`);
  }
  return resolved;
}

export const COMMIT_MESSAGE = "chore: upgrade to .NET 10 (LTS)";
export const COMMIT_IDENTITY = {
  name: "dotnet10-upgrader",
  email: "dotnet10-upgrader@users.noreply.github.com",
};
export const GIT_TIMEOUT_MS = 10 * 60_000;
export const REPO_NAME = /^[A-Za-z0-9._-]+$/;
export const ORG_NAME = /^[A-Za-z0-9-]+$/;
export const UPGRADE_BRANCH = /^chore\/dotnet10-upgrade-[0-9]{8}-[0-9]{3,6}$/;
export const DEFAULT_BRANCH = /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/;
export const GIT_SHA = /^[0-9a-f]{7,64}$/i;
export const RESULT_SCHEMA_VERSION = 1;
export const RUN_SCHEMA_VERSION = 1;
export const MAX_SUMMARY_CHARS = 60_000;
export const TOKEN_ENV_NAMES = new Set([
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
]);

export function redact(text: string, token: string): string {
  const clean = text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
  if (!token) return clean;
  const secrets = [
    token,
    Buffer.from(`x-access-token:${token}`).toString("base64"),
    Buffer.from(token).toString("base64"),
  ];
  return secrets.reduce((s, secret) => s.replaceAll(secret, "***"), clean);
}

export function childEnv(token: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (TOKEN_ENV_NAMES.has(k) || (token && v?.includes(token))) continue;
    next[k] = v;
  }
  return { ...next, MSBUILDDISABLENODEREUSE: "1", DOTNET_CLI_USE_MSBUILD_SERVER: "0" };
}

export const ARTIFACT_DIRS = ["bin", "obj", "TestResults"] as const;
export const ARTIFACT_EXCLUDES = [...ARTIFACT_DIRS.map((d) => `${d}/`), "*.binlog"];
/**
 * Case-insensitive: MSBuild on Windows writes `Obj\Debug\`, and a repository that committed
 * its build output under that spelling would otherwise be scanned as source and hard-fail the
 * suppression gate on generated code nobody wrote.
 */
export const ARTIFACT_PATH = new RegExp(`(^|/)(${ARTIFACT_DIRS.join("|")})/|\\.binlog$`, "i");
export const FORBIDDEN_PATH =
  /(^|\/)(\.github|\.claude|\.cursor|\.ssh)\/|(^|\/)(\.gitattributes|\.gitmodules|\.npmrc|\.netrc|\.envrc)$|(^|\/)\.env(\.|$)/;

export function isArtifactPath(p: string): boolean {
  return ARTIFACT_PATH.test(p);
}

export function isForbiddenPath(p: string): boolean {
  return FORBIDDEN_PATH.test(p);
}

export function isSafeName(name: string): boolean {
  return REPO_NAME.test(name) && name !== "." && name !== "..";
}

function isSafeDefaultBranch(name: string): boolean {
  return DEFAULT_BRANCH.test(name) && !name.includes("..") && !name.startsWith("-") && !name.startsWith("/");
}

function isStrictlyInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

export function expectedCloneDir(workDir: string, repo: string): string {
  return path.resolve(workDir, "repos", repo);
}

export function assertSafeCloneUrl(org: string, repo: string, cloneUrl: string, workDir: string): void {
  if (cloneUrl.startsWith("-") || cloneUrl.includes("\0")) {
    throw new OperatorError("invalid run manifest: cloneUrl must not start with -");
  }
  const expectedHttps = `https://github.com/${org}/${repo}.git`;
  if (cloneUrl === expectedHttps) return;
  if (!path.isAbsolute(cloneUrl)) {
    throw new OperatorError(
      "invalid run manifest: cloneUrl must be the GitHub HTTPS URL or an absolute path under workDir",
    );
  }
  const resolved = path.resolve(cloneUrl);
  const work = path.resolve(workDir);
  if (!isStrictlyInside(work, resolved)) {
    throw new OperatorError("invalid run manifest: cloneUrl path must be inside workDir");
  }
  try {
    const realUrl = fs.realpathSync(resolved);
    let realWork = work;
    try {
      realWork = fs.realpathSync(workDir);
    } catch {
      // workDir may not exist yet
    }
    if (!isStrictlyInside(realWork, realUrl)) {
      throw new OperatorError("invalid run manifest: cloneUrl path must be inside workDir");
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}

export function assertCloneLayout(
  workDir: string,
  repo: string,
  cloneDir: string,
  requireGit = false,
): string {
  if (!isSafeName(repo)) {
    throw new OperatorError(`refusing repo with unexpected name: ${JSON.stringify(repo)}`);
  }
  const expected = expectedCloneDir(workDir, repo);
  const resolved = path.resolve(cloneDir);
  if (resolved !== expected) {
    throw new OperatorError(`invalid run manifest: cloneDir must be ${expected}`);
  }
  try {
    fs.lstatSync(resolved);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      if (requireGit) throw new OperatorError(`clone directory does not exist: ${resolved}`);
      return resolved;
    }
    throw e;
  }
  const realClone = fs.realpathSync(resolved);
  let realWork = path.resolve(workDir);
  try {
    realWork = fs.realpathSync(workDir);
  } catch {
    // workDir may not exist yet
  }
  if (!isStrictlyInside(realWork, realClone) || path.relative(realWork, realClone) !== path.join("repos", repo)) {
    throw new OperatorError("invalid run manifest: cloneDir resolves outside the expected repo directory");
  }
  if (requireGit) {
    const gitDir = path.join(realClone, ".git");
    let gitSt: fs.Stats;
    try {
      gitSt = fs.lstatSync(gitDir);
    } catch {
      throw new OperatorError("clone is missing a .git directory");
    }
    if (!gitSt.isDirectory()) {
      throw new OperatorError("refusing clone whose .git is not a directory");
    }
  }
  return realClone;
}

export function assertManifestMatchesWorkDir(manifest: RunManifest, workDir: string): void {
  if (path.resolve(manifest.workDir) !== path.resolve(workDir)) {
    throw new OperatorError("run manifest workDir does not match config WORK_DIR");
  }
  assertCloneLayout(manifest.workDir, manifest.repo, manifest.cloneDir);
  assertSafeCloneUrl(manifest.org, manifest.repo, manifest.cloneUrl, manifest.workDir);
}

function isInheritedGitEnv(key: string): boolean {
  return (
    key.startsWith("GIT_") ||
    key === "SSH_ASKPASS" ||
    key === "LD_PRELOAD" ||
    key === "LD_AUDIT" ||
    key === "DYLD_INSERT_LIBRARIES"
  );
}

export function git(args: string[], cwd: string, token: string, authenticate = false): string {
  if (!path.isAbsolute(cwd)) {
    throw new Error("git cwd must be an absolute path");
  }
  let cwdStat: fs.Stats;
  try {
    cwdStat = fs.statSync(cwd);
  } catch {
    throw new Error(`git cwd is not a directory: ${cwd}`);
  }
  if (!cwdStat.isDirectory()) {
    throw new Error(`git cwd is not a directory: ${cwd}`);
  }

  const config: [string, string][] = [["core.hooksPath", "/dev/null"]];
  if (authenticate) {
    const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
    config.push(["http.https://github.com/.extraheader", `AUTHORIZATION: basic ${basic}`]);
  }
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(childEnv(token))) {
    if (isInheritedGitEnv(k)) continue;
    env[k] = v;
  }
  Object.assign(env, {
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
    SSH_ASKPASS: "",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: COMMIT_IDENTITY.name,
    GIT_AUTHOR_EMAIL: COMMIT_IDENTITY.email,
    GIT_COMMITTER_NAME: COMMIT_IDENTITY.name,
    GIT_COMMITTER_EMAIL: COMMIT_IDENTITY.email,
    GIT_CONFIG_COUNT: String(config.length),
  });
  for (const [i, [key, value]] of config.entries()) {
    env[`GIT_CONFIG_KEY_${i}`] = key;
    env[`GIT_CONFIG_VALUE_${i}`] = value;
  }
  const res = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: GIT_TIMEOUT_MS,
    env,
    shell: false,
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  });
  const verb = args[0] ?? "git";
  if (res.error) throw new Error(redact(`git ${verb}: ${res.error.message}`, token));
  if (res.status !== 0) throw new Error(redact(`git ${verb} failed: ${res.stderr}`, token));
  return res.stdout;
}

const retryLimit = 3;

export function createOctokit(token: string): Octokit {
  const ThrottledOctokit = Octokit.plugin(retry, throttling);
  return new ThrottledOctokit({
    auth: token,
    throttle: {
      onRateLimit: (retryAfter, opts, _octokit, retryCount) => {
        console.error(`rate limit on ${opts.method} ${opts.url}; retry ${retryCount + 1} in ${retryAfter}s`);
        return retryCount < retryLimit;
      },
      onSecondaryRateLimit: (retryAfter, opts, _octokit, retryCount) => {
        console.error(`secondary rate limit on ${opts.method} ${opts.url}; retry ${retryCount + 1} in ${retryAfter}s`);
        return retryCount < retryLimit;
      },
    },
  });
}

export type Finding = {
  severity: "critical" | "warning" | "suggestion";
  title: string;
  file?: string;
  line?: string;
  evidence?: string;
  impact?: string;
  recommendation?: string;
};

export type PackageDecision = {
  package: string;
  from?: string;
  to?: string;
  reason: string;
  evidence?: string;
};

export type TestChange = {
  file: string;
  change: string;
  reason: string;
};

export type UpgradeResult = {
  schemaVersion: 1;
  repo: string;
  branch: string;
  baseSha: string;
  baselineFailures: number;
  baselineFailureNames: string[];
  buildPassed: boolean;
  testsRegressed: boolean;
  reviewers: "PASS" | "FAIL";
  upgradeResult: "SUCCESS" | "FAILED";
  rounds: number;
  unresolvedCriticals: Finding[];
  warnings: Finding[];
  implementationSummary: string;
  testsRun: string[];
  residualRisks: string[];
  /** Optional so existing schemaVersion 1 results still validate; parses to [] when absent. */
  packageDecisions?: PackageDecision[];
  /** Optional so existing schemaVersion 1 results still validate; parses to [] when absent. */
  testChanges?: TestChange[];
};

export type MarkerVerdict =
  | { ok: true; baselineFailures: number }
  | { ok: false; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function reqResultString(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  if (typeof v !== "string") throw new OperatorError(`invalid upgrade result: ${key} must be a string`);
  return v;
}

function optString(obj: Record<string, unknown>, key: string): string | undefined {
  if (!(key in obj) || obj[key] === undefined) return undefined;
  const v = obj[key];
  if (typeof v !== "string") throw new OperatorError(`invalid upgrade result: ${key} must be a string`);
  return v;
}

function reqBoolean(obj: Record<string, unknown>, key: string): boolean {
  const v = obj[key];
  if (typeof v !== "boolean") throw new OperatorError(`invalid upgrade result: ${key} must be a boolean`);
  return v;
}

function reqInt(obj: Record<string, unknown>, key: string, min = 0): number {
  const v = obj[key];
  if (typeof v !== "number" || !Number.isInteger(v) || v < min) {
    throw new OperatorError(`invalid upgrade result: ${key} must be an integer >= ${min}`);
  }
  return v;
}

function reqStringArray(obj: Record<string, unknown>, key: string): string[] {
  const v = obj[key];
  if (!Array.isArray(v) || v.some((item) => typeof item !== "string")) {
    throw new OperatorError(`invalid upgrade result: ${key} must be an array of strings`);
  }
  return v;
}

function parseFinding(value: unknown, findingPath: string): Finding {
  if (!isRecord(value)) throw new OperatorError(`invalid upgrade result: ${findingPath} must be an object`);
  const severity = value.severity;
  if (severity !== "critical" && severity !== "warning" && severity !== "suggestion") {
    throw new OperatorError(`invalid upgrade result: ${findingPath}.severity is invalid`);
  }
  const finding: Finding = { severity, title: reqResultString(value, "title") };
  const file = optString(value, "file");
  const line = optString(value, "line");
  const evidence = optString(value, "evidence");
  const impact = optString(value, "impact");
  const recommendation = optString(value, "recommendation");
  if (file !== undefined) finding.file = file;
  if (line !== undefined) finding.line = line;
  if (evidence !== undefined) finding.evidence = evidence;
  if (impact !== undefined) finding.impact = impact;
  if (recommendation !== undefined) finding.recommendation = recommendation;
  return finding;
}

function reqFindingArray(obj: Record<string, unknown>, key: string): Finding[] {
  const v = obj[key];
  if (!Array.isArray(v)) throw new OperatorError(`invalid upgrade result: ${key} must be an array`);
  return v.map((item, i) => parseFinding(item, `${key}[${i}]`));
}

function parsePackageDecision(value: unknown, decisionPath: string): PackageDecision {
  if (!isRecord(value)) throw new OperatorError(`invalid upgrade result: ${decisionPath} must be an object`);
  const pkg = reqResultString(value, "package");
  if (!pkg.trim()) throw new OperatorError(`invalid upgrade result: ${decisionPath}.package must not be empty`);
  const reason = reqResultString(value, "reason");
  if (!reason.trim()) throw new OperatorError(`invalid upgrade result: ${decisionPath}.reason must not be empty`);
  const decision: PackageDecision = { package: pkg, reason };
  const from = optString(value, "from");
  const to = optString(value, "to");
  const evidence = optString(value, "evidence");
  if (from !== undefined) decision.from = from;
  if (to !== undefined) decision.to = to;
  if (evidence !== undefined) decision.evidence = evidence;
  return decision;
}

function optPackageDecisions(obj: Record<string, unknown>, key: string): PackageDecision[] {
  const v = obj[key];
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new OperatorError(`invalid upgrade result: ${key} must be an array`);
  return v.map((item, i) => parsePackageDecision(item, `${key}[${i}]`));
}

/** Symmetric with parsePackageDecision: a blank field is not a claim a reviewer can check. */
function reqNonBlank(obj: Record<string, unknown>, key: string, itemPath: string): string {
  const v = reqResultString(obj, key);
  if (!v.trim()) throw new OperatorError(`invalid upgrade result: ${itemPath}.${key} must not be empty`);
  return v;
}

function parseTestChange(value: unknown, changePath: string): TestChange {
  if (!isRecord(value)) throw new OperatorError(`invalid upgrade result: ${changePath} must be an object`);
  return {
    file: reqNonBlank(value, "file", changePath),
    change: reqNonBlank(value, "change", changePath),
    reason: reqNonBlank(value, "reason", changePath),
  };
}

function optTestChanges(obj: Record<string, unknown>, key: string): TestChange[] {
  const v = obj[key];
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new OperatorError(`invalid upgrade result: ${key} must be an array`);
  return v.map((item, i) => parseTestChange(item, `${key}[${i}]`));
}

export function parseUpgradeResult(value: unknown): UpgradeResult {
  if (!isRecord(value)) throw new OperatorError("invalid upgrade result: expected an object");
  if (value.schemaVersion !== RESULT_SCHEMA_VERSION) {
    throw new OperatorError(`invalid upgrade result: schemaVersion must be ${RESULT_SCHEMA_VERSION}`);
  }
  const reviewers = value.reviewers;
  if (reviewers !== "PASS" && reviewers !== "FAIL") {
    throw new OperatorError("invalid upgrade result: reviewers must be PASS or FAIL");
  }
  const upgradeResult = value.upgradeResult;
  if (upgradeResult !== "SUCCESS" && upgradeResult !== "FAILED") {
    throw new OperatorError("invalid upgrade result: upgradeResult must be SUCCESS or FAILED");
  }
  return {
    schemaVersion: RESULT_SCHEMA_VERSION,
    repo: reqResultString(value, "repo"),
    branch: reqResultString(value, "branch"),
    baseSha: reqResultString(value, "baseSha"),
    baselineFailures: reqInt(value, "baselineFailures"),
    baselineFailureNames: reqStringArray(value, "baselineFailureNames"),
    buildPassed: reqBoolean(value, "buildPassed"),
    testsRegressed: reqBoolean(value, "testsRegressed"),
    reviewers,
    upgradeResult,
    rounds: reqInt(value, "rounds"),
    unresolvedCriticals: reqFindingArray(value, "unresolvedCriticals"),
    warnings: reqFindingArray(value, "warnings"),
    implementationSummary: reqResultString(value, "implementationSummary"),
    testsRun: reqStringArray(value, "testsRun"),
    residualRisks: reqStringArray(value, "residualRisks"),
    packageDecisions: optPackageDecisions(value, "packageDecisions"),
    testChanges: optTestChanges(value, "testChanges"),
  };
}

export function parseMarkers(summary: string): MarkerVerdict {
  const lines = summary.split("\n").map((l) => l.trim()).filter(Boolean);
  const [baseline, reviewers, result] = lines.slice(-3);
  if (result !== "UPGRADE_RESULT: SUCCESS") {
    return { ok: false, reason: "loop did not report UPGRADE_RESULT: SUCCESS" };
  }
  if (reviewers !== "REVIEWERS: PASS") {
    return { ok: false, reason: `loop did not report REVIEWERS: PASS (found ${JSON.stringify(reviewers ?? "")})` };
  }
  const count = /^BASELINE_FAILURES: (\d+)$/.exec(baseline ?? "");
  const digits = count?.[1];
  if (!digits) {
    return { ok: false, reason: `loop did not report BASELINE_FAILURES (found ${JSON.stringify(baseline ?? "")})` };
  }
  return { ok: true, baselineFailures: Number(digits) };
}

/**
 * Writer rounds the loop can plausibly have dispatched. The loop caps its own at 4; the parser
 * only demands an integer >= 0, so `rounds: 0` and `rounds: 1e21` reach here and name no round
 * whose logs the evidence gate could read.
 */
export const MAX_ROUNDS = 50;

/**
 * Why this result may not be finalized, one reason per entry, so a refusal can name the field
 * that failed instead of leaving an operator to diff the document against the schema. The
 * self-consistency checks matter as much as the verdict fields: a critical finding filed under
 * `warnings` passes a gate whose stated meaning is "zero criticals", and a `rounds` value that
 * names no round leaves the round-log gate nothing to read.
 */
export function finalizableProblems(result: UpgradeResult): string[] {
  const problems: string[] = [];
  if (result.schemaVersion !== RESULT_SCHEMA_VERSION) {
    problems.push(`schemaVersion is ${result.schemaVersion}, expected ${RESULT_SCHEMA_VERSION}`);
  }
  if (result.reviewers !== "PASS") problems.push(`reviewers is ${result.reviewers}, expected PASS`);
  if (result.upgradeResult !== "SUCCESS") {
    problems.push(`upgradeResult is ${result.upgradeResult}, expected SUCCESS`);
  }
  if (result.buildPassed !== true) problems.push("buildPassed is false");
  if (result.testsRegressed !== false) problems.push("testsRegressed is true");
  if (result.unresolvedCriticals.length !== 0) {
    problems.push(`unresolvedCriticals holds ${result.unresolvedCriticals.length} finding(s)`);
  }
  const misfiled = result.warnings.filter((w) => w.severity === "critical");
  if (misfiled.length) {
    problems.push(
      `warnings holds ${misfiled.length} finding(s) with severity "critical" (first: ${JSON.stringify(misfiled[0]?.title ?? "")}); a critical belongs in unresolvedCriticals, which this gate requires to be empty`,
    );
  }
  if (!Number.isInteger(result.baselineFailures) || result.baselineFailures < 0) {
    problems.push(`baselineFailures is ${result.baselineFailures}, expected an integer >= 0`);
  }
  if (!Number.isInteger(result.rounds) || result.rounds < 1 || result.rounds > MAX_ROUNDS) {
    problems.push(`rounds is ${result.rounds}, expected an integer between 1 and ${MAX_ROUNDS}`);
  }
  if (result.testsRun.length === 0) {
    problems.push("testsRun is empty; the build and test commands actually run must be recorded");
  }
  if (result.baselineFailures > 0 && result.baselineFailureNames.length === 0) {
    problems.push(
      `baselineFailures is ${result.baselineFailures} but baselineFailureNames is empty; a carried failure has to be named to be checkable on the base branch`,
    );
  }
  return problems;
}

export function isFinalizable(result: UpgradeResult): boolean {
  return finalizableProblems(result).length === 0;
}

export function validateResult(
  value: unknown,
  expected: { repo: string; branch: string; baseSha: string },
): UpgradeResult {
  const result = parseUpgradeResult(value);
  if (result.repo !== expected.repo || result.branch !== expected.branch || result.baseSha !== expected.baseSha) {
    throw new OperatorError(
      `upgrade result identity mismatch: got repo=${JSON.stringify(result.repo)} branch=${JSON.stringify(result.branch)} baseSha=${JSON.stringify(result.baseSha)}, expected repo=${JSON.stringify(expected.repo)} branch=${JSON.stringify(expected.branch)} baseSha=${JSON.stringify(expected.baseSha)}`,
    );
  }
  return result;
}

/** Shape of the trailer the writer contract requires at the end of implementationSummary. */
const MARKER_TRAILER = [
  /^BASELINE_FAILURES:\s*\S+$/,
  /^REVIEWERS:\s*\S+$/,
  /^UPGRADE_RESULT:\s*\S+$/,
] as const;

/**
 * Drop a marker trailer the writer already wrote. It is dropped whether or not it agrees with
 * the parent's values: the parent derives them from the loop ledger and recorded logs, so a
 * writer trailer that disagrees is stale and must not be what the reader sees.
 */
function stripMarkerTrailer(body: string): string {
  const lines = body.split("\n");
  const tail: number[] = [];
  for (let i = lines.length - 1; i >= 0 && tail.length < MARKER_TRAILER.length; i -= 1) {
    if (lines[i]?.trim()) tail.unshift(i);
  }
  const start = tail[0];
  if (tail.length < MARKER_TRAILER.length || start === undefined) return body;
  const isTrailer = tail.every((line, i) => MARKER_TRAILER[i]?.test(lines[line]?.trim() ?? ""));
  return isTrailer ? lines.slice(0, start).join("\n").trimEnd() : body;
}

export function summaryText(result: UpgradeResult): string {
  const markers = [
    `BASELINE_FAILURES: ${result.baselineFailures}`,
    `REVIEWERS: ${result.reviewers}`,
    `UPGRADE_RESULT: ${result.upgradeResult}`,
  ].join("\n");
  const body = stripMarkerTrailer(result.implementationSummary.trimEnd());
  return body ? `${body}\n${markers}` : markers;
}

export type RunPhase = "prepared" | "loop-complete" | "finalized" | "failed";

export type RunManifest = {
  schemaVersion: 1;
  runId: string;
  phase: RunPhase;
  org: string;
  repo: string;
  defaultBranch: string;
  upgradeBranch: string;
  cloneDir: string;
  workDir: string;
  baseSha: string;
  cloneUrl: string;
  createdAt: string;
  /**
   * sha256 of the `result.json` bytes the gate read, and of the round logs it verified,
   * recorded when the run was gated. `finalize` runs minutes later in another process, so
   * without these it re-reads whatever is on disk by then: the `testChanges` and
   * `packageDecisions` entries that waive a deleted test and an unexplained package can be
   * appended after the only review the run gets.
   */
  resultDigest?: string;
  roundLogsDigest?: string;
};

/** What the gate records about the evidence it read, for `finalize` to re-check. */
export type GateDigests = { resultDigest: string; roundLogsDigest: string };

const PHASES: readonly RunPhase[] = ["prepared", "loop-complete", "finalized", "failed"];
const SHA256_HEX = /^[0-9a-f]{64}$/;

const ALLOWED_TRANSITIONS: Record<RunPhase, readonly RunPhase[]> = {
  prepared: ["loop-complete", "failed"],
  "loop-complete": ["finalized", "failed"],
  failed: ["failed"],
  finalized: ["finalized"],
};

function reqManifestString(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  if (typeof v !== "string" || !v) throw new OperatorError(`invalid run manifest: ${key} must be a non-empty string`);
  return v;
}

function parseManifest(value: unknown): RunManifest {
  if (!isRecord(value)) throw new OperatorError("invalid run manifest: expected an object");
  if (value.schemaVersion !== RUN_SCHEMA_VERSION) {
    throw new OperatorError(`invalid run manifest: schemaVersion must be ${RUN_SCHEMA_VERSION}`);
  }
  const phase = value.phase;
  if (typeof phase !== "string" || !(PHASES as readonly string[]).includes(phase)) {
    throw new OperatorError("invalid run manifest: phase is invalid");
  }
  const cloneDir = reqManifestString(value, "cloneDir");
  const workDir = reqManifestString(value, "workDir");
  if (!path.isAbsolute(cloneDir) || !path.isAbsolute(workDir)) {
    throw new OperatorError("invalid run manifest: cloneDir and workDir must be absolute");
  }
  const runId = reqManifestString(value, "runId");
  const org = reqManifestString(value, "org");
  const repo = reqManifestString(value, "repo");
  const defaultBranch = reqManifestString(value, "defaultBranch");
  const upgradeBranch = reqManifestString(value, "upgradeBranch");
  const baseSha = reqManifestString(value, "baseSha");
  const cloneUrl = reqManifestString(value, "cloneUrl");
  if (!isSafeName(runId)) throw new OperatorError(`invalid runId: ${JSON.stringify(runId)}`);
  if (!ORG_NAME.test(org)) throw new OperatorError(`invalid run manifest: org is invalid`);
  if (!isSafeName(repo)) throw new OperatorError(`refusing repo with unexpected name: ${JSON.stringify(repo)}`);
  if (!isSafeDefaultBranch(defaultBranch)) throw new OperatorError("invalid run manifest: defaultBranch is invalid");
  if (!UPGRADE_BRANCH.test(upgradeBranch)) throw new OperatorError("invalid run manifest: upgradeBranch is invalid");
  if (!GIT_SHA.test(baseSha)) throw new OperatorError("invalid run manifest: baseSha is invalid");
  assertCloneLayout(workDir, repo, cloneDir);
  assertSafeCloneUrl(org, repo, cloneUrl, workDir);
  const manifest: RunManifest = {
    schemaVersion: RUN_SCHEMA_VERSION,
    runId,
    phase: phase as RunPhase,
    org,
    repo,
    defaultBranch,
    upgradeBranch,
    cloneDir: path.resolve(cloneDir),
    workDir: path.resolve(workDir),
    baseSha,
    cloneUrl,
    createdAt: reqManifestString(value, "createdAt"),
  };
  for (const key of ["resultDigest", "roundLogsDigest"] as const) {
    const digest = value[key];
    if (digest === undefined) continue;
    if (typeof digest !== "string" || !SHA256_HEX.test(digest)) {
      throw new OperatorError(`invalid run manifest: ${key} must be a sha256 hex digest`);
    }
    manifest[key] = digest;
  }
  return manifest;
}

export function runDir(workDir: string, runId: string): string {
  if (!isSafeName(runId)) {
    throw new OperatorError(`invalid runId: ${JSON.stringify(runId)}`);
  }
  return path.join(workDir, "runs", runId);
}

export function manifestPath(dir: string): string {
  return path.join(dir, "manifest.json");
}

export function resultPath(dir: string): string {
  return path.join(dir, "result.json");
}

export function auditPath(dir: string): string {
  return path.join(dir, "audit.md");
}

export function pristineGitConfigPath(dir: string): string {
  return path.join(dir, "git-config");
}

export function writeJsonAtomic(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${process.pid}.${process.hrtime.bigint()}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, filePath);
  } catch (e) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // best effort
    }
    throw e;
  }
}

export function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function writeManifest(dir: string, manifest: RunManifest): void {
  writeJsonAtomic(manifestPath(dir), manifest);
}

export function readManifest(dir: string): RunManifest {
  return parseManifest(readJson(manifestPath(dir)));
}

export function writeResult(dir: string, result: UpgradeResult): void {
  writeJsonAtomic(resultPath(dir), result);
}

export function readResult(dir: string): UpgradeResult {
  return parseUpgradeResult(readJson(resultPath(dir)));
}

function writePrivateFile(filePath: string, data: string | Buffer): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.rmSync(filePath, { force: true });
  fs.writeFileSync(filePath, data, { mode: 0o600, flag: "wx" });
}

export function writeAudit(dir: string, text: string): void {
  writePrivateFile(auditPath(dir), text);
}

export function writeLog(workDir: string, repo: string, text: string): string {
  if (!isSafeName(repo)) {
    throw new Error(`refusing log for unexpected repo name: ${JSON.stringify(repo)}`);
  }
  const logFile = path.join(workDir, "logs", `${repo}.log`);
  writePrivateFile(logFile, text);
  return logFile;
}

export function writePristineGitConfig(dir: string, buf: Buffer): void {
  const dest = pristineGitConfigPath(dir);
  fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
  const tmp = `${dest}.${process.pid}.${process.hrtime.bigint()}.tmp`;
  try {
    fs.writeFileSync(tmp, buf, { mode: 0o600 });
    fs.renameSync(tmp, dest);
  } catch (e) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // best effort
    }
    throw e;
  }
}

export function readPristineGitConfig(dir: string): Buffer {
  return fs.readFileSync(pristineGitConfigPath(dir));
}

/**
 * Write `next` over the phase this handle was read at, refusing if the run directory moved on
 * in between. The handle is a snapshot: `complete-run` and `finalize` are separate processes
 * minutes apart, and guarding the in-memory phase alone lets a stale `prepared` handle rewind
 * a run that is already `finalized`, whose PR is already open, into a second finalize.
 */
function swapPhase(manifest: RunManifest, next: RunPhase, digests?: GateDigests): RunManifest {
  const dir = runDir(manifest.workDir, manifest.runId);
  const onDisk = readManifest(dir);
  if (onDisk.phase !== manifest.phase) {
    throw new OperatorError(
      `run ${manifest.runId} changed phase underneath this handle: it was read at ${manifest.phase}, the run directory now says ${onDisk.phase}; re-read the manifest before transitioning`,
    );
  }
  const updated: RunManifest = { ...onDisk, ...digests, phase: next };
  writeManifest(dir, updated);
  return updated;
}

export function transitionPhase(manifest: RunManifest, next: RunPhase, digests?: GateDigests): RunManifest {
  const allowed = ALLOWED_TRANSITIONS[manifest.phase];
  if (!allowed.includes(next)) {
    throw new OperatorError(`illegal phase transition: ${manifest.phase} -> ${next}`);
  }
  return swapPhase(manifest, next, digests);
}

export function assertResultIdentity(manifest: RunManifest, result: UpgradeResult): void {
  if (result.repo !== manifest.repo || result.branch !== manifest.upgradeBranch || result.baseSha !== manifest.baseSha) {
    throw new OperatorError(
      `result identity does not match run ${manifest.runId}: expected repo=${manifest.repo} branch=${manifest.upgradeBranch} baseSha=${manifest.baseSha}`,
    );
  }
}

export function roundBuildLogName(round: number): string {
  return `round-${round}-build.log`;
}

export function roundTestLogName(round: number): string {
  return `round-${round}-test.log`;
}

/** What a refusal tells the writer to produce; the loop skill names the same two files. */
function logContract(round: number): string {
  return (
    `the run directory must hold ${roundBuildLogName(round)} and ${roundTestLogName(round)} ` +
    "(round N is the `rounds` value in result.json), each a regular file with content: the " +
    'build log has to carry the `dotnet build` verdict line ("Build succeeded"), and the test ' +
    'log the `dotnet test` verdict ("Passed!", or "Failed! - Failed: N" with N no larger than ' +
    "the recorded baselineFailures). Redirect the real command output into them, e.g. " +
    "`dotnet build 2>&1 | tee $RUN_DIR/" +
    roundBuildLogName(round) +
    "`"
  );
}

/** `dotnet build` / MSBuild verdicts, terminal logger and classic console logger alike. */
const BUILD_PASSED = /build\s+succeeded/i;
const BUILD_FAILED = /build\s+(?:has\s+)?failed/i;
/** `dotnet test` verdicts: VSTest's `Passed!`/`Failed!` banners and the older Test Run lines. */
const TEST_PASSED = /(?:^|[^A-Za-z])Passed!|Test Run Successful\./;
const TEST_FAILED = /(?:^|[^A-Za-z])Failed!|Test Run Failed\./;
/** `Failed:     3` in either banner, once per test project. */
const TEST_FAILURE_COUNT = /\bfailed:\s*(\d+)/gi;

function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * One round log's bytes. `lstat` rather than `stat` is the point: a name that passes a
 * `readdirSync` regex can be a directory, a dangling symlink, or a link to a green log
 * outside the run directory, and none of those is evidence of anything.
 */
function readRoundLog(dir: string, name: string, runId: string, round: number): Buffer {
  const file = path.join(dir, name);
  const refuse = (why: string): OperatorError =>
    new OperatorError(`run ${runId} has no persisted round build/test logs: ${name} ${why}. To finalize, ${logContract(round)}`);
  let st: fs.Stats;
  try {
    st = fs.lstatSync(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    throw refuse(`is missing from ${dir}`);
  }
  if (st.isSymbolicLink()) throw refuse("is a symlink; the gate reads regular files only, so a log cannot be a pointer at one outside the run directory");
  if (!st.isFile()) throw refuse("is not a regular file");
  if (st.size === 0) throw refuse("is empty");
  return fs.readFileSync(file);
}

/**
 * The persisted round logs are the only mechanical proof that the final writer round built and
 * tested: the parent cannot run `dotnet` itself without writing bin/ and obj/ into the clone
 * under review, so a result.json claiming a green suite with no logs behind it is unverifiable.
 * Reading the names alone proved nothing — two empty files, or a test log reading
 * `Failed! - Failed: 41`, advanced the run — so this opens both and checks the verdicts against
 * the round and the baseline the result claims. Returns the digest binding the run to the logs
 * it was gated on.
 */
export function verifyRoundLogs(dir: string, runId: string, result: UpgradeResult): string {
  const round = result.rounds;
  if (!Number.isInteger(round) || round < 1 || round > MAX_ROUNDS) {
    throw new OperatorError(
      `run ${runId} records rounds=${result.rounds}, which names no writer round whose logs could be read; expected an integer between 1 and ${MAX_ROUNDS}`,
    );
  }
  const buildName = roundBuildLogName(round);
  const testName = roundTestLogName(round);
  const build = readRoundLog(dir, buildName, runId, round);
  const test = readRoundLog(dir, testName, runId, round);
  const refuse = (why: string): never => {
    throw new OperatorError(`run ${runId} ${why}. To finalize, ${logContract(round)}`);
  };

  const buildText = build.toString("utf8");
  if (BUILD_FAILED.test(buildText)) {
    refuse(`records a failed build for round ${round}: ${buildName} says the build FAILED`);
  }
  if (!BUILD_PASSED.test(buildText)) {
    refuse(`has no build verdict for round ${round}: ${buildName} contains neither "Build succeeded" nor a failure line, so it is not the output of a build`);
  }

  const testText = test.toString("utf8");
  const counts = [...testText.matchAll(TEST_FAILURE_COUNT)].map((m) => Number(m[1]));
  const passed = TEST_PASSED.test(testText);
  const failed = TEST_FAILED.test(testText);
  if (!passed && !failed && counts.length === 0) {
    refuse(`has no test verdict for round ${round}: ${testName} contains no "Passed!" or "Failed!" line and no "Failed: N" count, so it is not the output of a test run`);
  }
  if (failed && counts.length === 0) {
    refuse(`cannot account for the failures in ${testName}: it reports a failed test run but carries no "Failed: N" count to compare against baselineFailures`);
  }
  const failures = counts.reduce((total, n) => total + n, 0);
  if (failures > result.baselineFailures) {
    refuse(
      `reports more failing tests than the run carries as baseline: ${testName} counts ${failures} failure(s), result.json records baselineFailures=${result.baselineFailures}`,
    );
  }
  return sha256([
    `${buildName} ${sha256(build)}`,
    `${testName} ${sha256(test)}`,
  ].join("\n"));
}

/**
 * The result document the loop was supposed to leave, with the missing-file case named.
 * The bytes come back with the parsed result so every consumer hashes and reviews the
 * same read: a second read would let a writer flip the file between them and ship
 * claims the gate never reviewed.
 */
function readRunResultBytes(dir: string, runId: string): { bytes: Buffer; result: UpgradeResult } {
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(resultPath(dir));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      throw new OperatorError(
        `run ${runId} has no result.json in ${dir}; the writer loop must persist its result document there before the run can be completed or finalized`,
      );
    }
    throw e;
  }
  return { bytes, result: parseUpgradeResult(JSON.parse(bytes.toString("utf8"))) };
}

/** Evidence the gate read, hashed so `finalize` can tell it is looking at the same files. */
function gateDigests(dir: string, runId: string, resultBytes: Buffer, result: UpgradeResult): GateDigests {
  return {
    resultDigest: sha256(resultBytes),
    roundLogsDigest: verifyRoundLogs(dir, runId, result),
  };
}

/** Advance prepared → loop-complete after a finalizable result.json is on disk. */
export function markLoopComplete(workDir: string, runId: string): RunManifest {
  const dir = runDir(workDir, runId);
  const manifest = readManifest(dir);
  assertManifestMatchesWorkDir(manifest, workDir);
  const { bytes, result } = readRunResultBytes(dir, runId);
  assertResultIdentity(manifest, result);
  const problems = finalizableProblems(result);
  if (problems.length) {
    throw new OperatorError(`run ${runId} result is not finalizable: ${problems.join("; ")}`);
  }
  const digests = gateDigests(dir, runId, bytes, result);
  // Re-gating an already complete run re-records the digests, so a legitimate extra round
  // rebinds the run to the evidence it actually ends on.
  if (manifest.phase === "loop-complete") return swapPhase(manifest, "loop-complete", digests);
  return transitionPhase(manifest, "loop-complete", digests);
}

export async function prepareRepo(
  _octokit: Octokit,
  config: AppConfig,
  report: RepoReport,
): Promise<RunManifest> {
  if (!isSafeName(report.name)) {
    throw new Error(`refusing repo with unexpected name: ${JSON.stringify(report.name)}`);
  }
  const workDir = resolveWorkDir(config.workDir);
  const repoDir = expectedCloneDir(workDir, report.name);
  const now = new Date();
  const stamp = now.toISOString().replace(/[-:]/g, "").slice(0, 15).replace("T", "-");
  const runId = `${report.name}-${stamp}`;
  const dir = runDir(workDir, runId);
  const upgradeBranch = `chore/dotnet10-upgrade-${stamp}`;
  const cloneUrl = `https://github.com/${config.org}/${report.name}.git`;

  fs.mkdirSync(path.join(workDir, "repos"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(workDir, "runs"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(workDir, "logs"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const realWork = fs.realpathSync(workDir);
  const realRepos = fs.realpathSync(path.join(workDir, "repos"));
  if (path.relative(realWork, realRepos) !== "repos") {
    throw new OperatorError("refusing WORK_DIR whose repos/ resolves outside the work directory");
  }
  fs.rmSync(repoDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });

  git(["clone", "--depth", "1", "--", cloneUrl, repoDir], workDir, config.token, true);
  assertCloneLayout(workDir, report.name, repoDir, true);
  git(["checkout", "-b", upgradeBranch], repoDir, config.token);

  const gitConfigFile = path.join(repoDir, ".git", "config");
  writePristineGitConfig(dir, fs.readFileSync(gitConfigFile));

  const baseSha = git(["rev-parse", "HEAD"], repoDir, config.token).trim();
  const dirty = git(["status", "--porcelain"], repoDir, config.token);
  if (dirty.trim()) {
    throw new Error(`working tree is not clean after clone: ${dirty.trim()}`);
  }
  const head = git(["rev-parse", "--abbrev-ref", "HEAD"], repoDir, config.token).trim();
  if (head !== upgradeBranch) {
    throw new Error(`expected HEAD on ${upgradeBranch} after checkout, found ${head}`);
  }

  const manifest: RunManifest = {
    schemaVersion: RUN_SCHEMA_VERSION,
    runId,
    phase: "prepared",
    org: config.org,
    repo: report.name,
    defaultBranch: report.defaultBranch,
    upgradeBranch,
    cloneDir: path.resolve(repoDir),
    workDir,
    baseSha,
    cloneUrl,
    createdAt: now.toISOString(),
  };
  writeManifest(dir, manifest);
  return manifest;
}

export type UpgradeOutcome = { ok: boolean; prUrl?: string; reason?: string; logPath?: string; runId: string };

const PR_PREAMBLE =
  "This pull request was produced by the automated dotnet10-upgrader loop (Cursor engineering-implementation-loop). " +
  "Review the diff and check CI against the test status stated below before merging.";

/** GitHub rejects a pull request body longer than this. */
export const MAX_BODY_CHARS = 65_536;
export const MAX_CODE_CHARS = 200;
export const MAX_TEXT_CHARS = 600;
export const MAX_DEPENDENCY_SECTION_CHARS = 20_000;
/** New references are rare by policy; list enough to review and count the rest. */
const MAX_ADDED_REFERENCES = 20;
/** A test the upgrade changes is rare by policy too; list enough to review and count the rest. */
const MAX_TEST_CHANGES = 20;
const MIN_SUMMARY_CHARS = 200;
const EMPTY_CELL = "—";

/**
 * Inline code for a short untrusted value (package id, version, path, command). GitHub does not
 * autolink mentions or issue refs inside a code span, so this is the guard for those; the fence
 * is longer than any backtick run in the value, and the pipe escape keeps table cells intact.
 * Returns "" when there is nothing left to render.
 */
export function mdCode(value: string, token: string): string {
  const flat = redact(value, token).replace(/\s+/g, " ").trim();
  if (!flat) return "";
  const clipped = flat.length > MAX_CODE_CHARS ? `${flat.slice(0, MAX_CODE_CHARS)}…` : flat;
  const escaped = clipped.replaceAll("|", "\\|");
  const longest = Math.max(0, ...[...escaped.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  const pad = escaped.startsWith("`") || escaped.endsWith("`") ? " " : "";
  return `${fence}${pad}${escaped}${pad}${fence}`;
}

/**
 * Untrusted prose rendered as markdown text: one line, no HTML, no live mentions or issue refs,
 * no link syntax, and no way out of a table cell. `@` and `#` become numeric character
 * references, which render as themselves but are not autolink source text.
 */
export function mdText(value: string, token: string): string {
  const flat = redact(value, token).replace(/\s+/g, " ").trim();
  if (!flat) return "";
  const clipped = flat.length > MAX_TEXT_CHARS ? `${flat.slice(0, MAX_TEXT_CHARS)}…` : flat;
  // Order matters: & is escaped first so it cannot forge an entity, then # is neutralized
  // before any &#nn; is introduced, and @ last because its replacement contains a #.
  return clipped
    .replaceAll("\\", "\\\\")
    .replaceAll("&", "&amp;")
    .replaceAll("#", "&#35;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("[", "&#91;")
    .replaceAll("]", "&#93;")
    .replaceAll("`", "&#96;")
    .replaceAll("|", "\\|")
    .replaceAll("@", "&#64;");
}

function versionCell(version: string | undefined, token: string): string {
  if (version === undefined) return EMPTY_CELL;
  return mdCode(version, token) || "_(no version attribute)_";
}

function decisionRange(decision: PackageDecision, token: string): string {
  if (decision.from === undefined && decision.to === undefined) return "";
  return ` (${versionCell(decision.from, token)} → ${versionCell(decision.to, token)})`;
}

function reasonCell(decision: PackageDecision | undefined, token: string): string {
  if (!decision) return "_No rationale recorded._";
  const reason = mdText(decision.reason, token) || "_No rationale recorded._";
  const evidence = decision.evidence ? mdText(decision.evidence, token) : "";
  return evidence ? `${reason} (evidence: ${evidence})` : reason;
}

function dependencySection(
  decisions: PackageDecision[],
  dependencies: DependencyChanges,
  token: string,
  addedManifests: readonly string[] = [],
): string[] {
  const lines = ["### Dependency and package reasoning", ""];
  const claimed = new Set<number>();
  const matchDecision = (id: string): PackageDecision | undefined => {
    const key = id.trim().toLowerCase();
    const i = decisions.findIndex((d, idx) => !claimed.has(idx) && d.package.trim().toLowerCase() === key);
    if (i < 0) return undefined;
    claimed.add(i);
    return decisions[i];
  };

  if (dependencies.packages.length) {
    lines.push(
      "Version moves below are read from the staged diff, not from the agent's report; only the reason column is agent-authored.",
      "",
      "| Package | From | To | Source | Reason |",
      "| :--- | :--- | :--- | :--- | :--- |",
    );
    let used = 0;
    let dropped = 0;
    for (const change of dependencies.packages) {
      const decision = matchDecision(change.package);
      const row = `| ${mdCode(change.package, token) || EMPTY_CELL} | ${versionCell(change.from, token)} | ${versionCell(change.to, token)} | ${mdCode(change.file, token) || EMPTY_CELL} | ${reasonCell(decision, token)} |`;
      if (used + row.length > MAX_DEPENDENCY_SECTION_CHARS) {
        dropped += 1;
        continue;
      }
      used += row.length;
      lines.push(row);
    }
    const omitted = dropped + dependencies.omitted;
    if (omitted > 0) lines.push("", `…${omitted} more change(s) omitted.`);
  } else {
    lines.push("No package versions changed; this was a target-framework-only upgrade.");
  }

  const allAdded = addedPackages(dependencies);
  const added = allAdded.filter((change) => !isNewManifest(addedManifests, change.file));
  const inNewProjects = allAdded.filter((change) => isNewManifest(addedManifests, change.file));
  if (added.length) {
    lines.push(
      "",
      "#### New package references",
      "",
      "References the base branch did not have, in projects it did. Finalize opens no PR unless the recorded decision quotes the restore or build error that made the package necessary.",
      "",
    );
    for (const change of added.slice(0, MAX_ADDED_REFERENCES)) {
      const key = change.package.trim().toLowerCase();
      const decision = decisions.find((d) => d.package.trim().toLowerCase() === key);
      const evidence = decision?.evidence ? mdText(decision.evidence, token) : "_No evidence recorded._";
      lines.push(
        `- ${mdCode(change.package, token) || EMPTY_CELL} at ${versionCell(change.to, token)} in ${mdCode(change.file, token) || EMPTY_CELL} — required by: ${evidence}`,
      );
    }
    if (added.length > MAX_ADDED_REFERENCES) {
      lines.push(`- …${added.length - MAX_ADDED_REFERENCES} more new reference(s) omitted.`);
    }
  }

  if (inNewProjects.length) {
    lines.push(
      "",
      "#### References declared by project files this PR adds",
      "",
      "These manifests do not exist on the base branch, so everything they reference reads as new. The evidence gate does not apply to them — a new project has to declare its dependencies — so check here that the project belongs in the upgrade and that its references do too.",
      "",
    );
    for (const change of inNewProjects.slice(0, MAX_ADDED_REFERENCES)) {
      lines.push(
        `- ${mdCode(change.package, token) || EMPTY_CELL} at ${versionCell(change.to, token)} in ${mdCode(change.file, token) || EMPTY_CELL}`,
      );
    }
    if (inNewProjects.length > MAX_ADDED_REFERENCES) {
      lines.push(`- …${inNewProjects.length - MAX_ADDED_REFERENCES} more reference(s) omitted.`);
    }
  }

  const moves: string[] = [];
  for (const change of dependencies.frameworks) {
    moves.push(
      `- Target frameworks in ${mdCode(change.file, token)}: ${versionCell(change.from, token)} → ${versionCell(change.to, token)}`,
    );
  }
  for (const change of dependencies.sdks) {
    moves.push(
      `- SDK pin in ${mdCode(change.file, token)}: ${versionCell(change.from, token)} → ${versionCell(change.to, token)}`,
    );
  }
  for (const change of dependencies.images) {
    moves.push(
      `- Base image ${mdCode(change.image, token) || EMPTY_CELL} in ${mdCode(change.file, token)}: ${versionCell(change.from, token)} → ${versionCell(change.to, token)}`,
    );
  }
  if (moves.length) lines.push("", "#### Framework, SDK, and base-image moves", "", ...moves);

  if (dependencies.skipped.length) {
    const names = dependencies.skipped.map((f) => mdCode(f, token) || EMPTY_CELL).join(", ");
    lines.push("", `Manifests too large to summarise here: ${names}. Read them in the diff.`);
  }

  const unmatched = decisions.filter((_, i) => !claimed.has(i));
  if (unmatched.length) {
    lines.push("", "#### Decisions recorded with no matching change in the diff", "");
    for (const decision of unmatched) {
      lines.push(
        `- ${mdCode(decision.package, token) || EMPTY_CELL}${decisionRange(decision, token)}: ${reasonCell(decision, token)}`,
      );
    }
  }
  return lines;
}

function findingLine(finding: Finding, token: string): string {
  const where = finding.file ? ` — ${mdCode(finding.file, token)}${finding.line ? `:${mdCode(finding.line, token)}` : ""}` : "";
  const detail = finding.recommendation ?? finding.impact ?? finding.evidence;
  const tail = detail ? ` — ${mdText(detail, token)}` : "";
  return `- ${mdText(finding.severity, token)}: ${mdText(finding.title, token)}${where}${tail}`;
}

function runSummarySection(result: UpgradeResult, token: string): string[] {
  const lines = ["### Agent run summary", ""];
  const verification =
    result.baselineFailures === 0
      ? "`dotnet build` and `dotnet test` both passed in the agent's clone."
      : `\`dotnet build\` passed; \`dotnet test\` still reports the ${result.baselineFailures} failure(s) that were already failing on the base branch, and no others.`;
  lines.push(
    `- Verification: ${verification}`,
    `- Loop verdict: reviewers ${mdCode(result.reviewers, token)}, upgrade ${mdCode(result.upgradeResult, token)}, after ${result.rounds} writer round(s).`,
  );
  if (result.testsRun.length) {
    lines.push("- Commands run:");
    for (const command of result.testsRun) lines.push(`  - ${mdCode(command, token) || EMPTY_CELL}`);
  }
  if (result.baselineFailureNames.length) {
    lines.push(`- Carried baseline failures (${result.baselineFailureNames.length}):`);
    for (const name of result.baselineFailureNames) lines.push(`  - ${mdCode(name, token) || EMPTY_CELL}`);
  }
  if (result.residualRisks.length) {
    lines.push("- Residual risks:");
    for (const risk of result.residualRisks) lines.push(`  - ${mdText(risk, token) || EMPTY_CELL}`);
  }
  if (result.warnings.length) {
    lines.push("- Warnings:");
    for (const warning of result.warnings) lines.push(`  ${findingLine(warning, token)}`);
  }
  const testChanges = result.testChanges ?? [];
  if (testChanges.length) {
    lines.push(
      "",
      "#### Tests the upgrade changed",
      "",
      "Tests the retarget changed, as recorded by the agent. Every row is a change the weakening scan either found in the diff or would have refused the PR over: finalize opens no PR when the diff disables, unregisters or removes a test that no entry here names with a reason. Read each row against the diff — the reason is the agent's claim, not a verified fact.",
      "",
    );
    for (const change of testChanges.slice(0, MAX_TEST_CHANGES)) {
      lines.push(
        `- ${mdCode(change.file, token) || EMPTY_CELL} — ${mdText(change.change, token) || EMPTY_CELL} (${mdText(change.reason, token) || EMPTY_CELL})`,
      );
    }
    if (testChanges.length > MAX_TEST_CHANGES) {
      lines.push(`- …${testChanges.length - MAX_TEST_CHANGES} more test change(s) omitted.`);
    }
  }
  return lines;
}

function fencedSummary(summary: string, budget: number): string {
  const clipped = summary.length > budget ? `${summary.slice(0, budget)}\n…(truncated)` : summary;
  const longest = Math.max(0, ...[...clipped.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}text\n${clipped}\n${fence}`;
}

/**
 * What the gates mechanically check, stated as what they check. The detectors verify deletion,
 * skipping, unregistration, renames out of the build and project plumbing; they deliberately do
 * not look for assertions removed from a test that keeps its `[Fact]`, because a removed-assert
 * pattern fires on every legitimate refactor (see `src/packages.ts`). Claiming no test was
 * "otherwise weakened" would assert the one thing here that nothing verifies.
 */
const GATE_CLAIMS =
  "Scope: a package version moves here only where the `net10.0` retarget forced it. Warnings and vulnerability advisories that already applied on the base branch are left as they were, and fixing those is a separate pull request. " +
  "Before opening this PR, finalize scanned the committed diff and would have refused it outright if the diff had added a warning suppression (`NoWarn`, `#pragma warning disable`, `SuppressMessage`, an analyzer severity downgrade, a relaxed `NuGetAudit*` setting), added a package reference with no recorded build or restore error behind it, or deleted a test file, skipped or ignored a test, removed a test attribute, renamed a test out of the build, or unplugged a test project from the build — unless the run recorded a reason naming that file. " +
  "Those scans read the diff for those constructs and nothing else: they do not judge whether a test that kept its `[Fact]` still asserts as much as it did, so read the test diff yourself.";

export function prBody(
  result: UpgradeResult,
  dependencies: DependencyChanges,
  token: string,
  addedManifests: readonly string[] = [],
): string {
  const baselineFailures = result.baselineFailures;
  const tests =
    baselineFailures === 0
      ? "`dotnet build` and `dotnet test` both pass — the loop opens no PR otherwise."
      : `\`dotnet build\` passes. ${baselineFailures} test(s) were already failing on the base branch before this change and still fail, unchanged; no test that was passing now fails — the loop opens no PR otherwise.`;
  const checklist = ["- [ ] Code pipeline builds correctly"];
  if (baselineFailures > 0) {
    checklist.push(`- [ ] The ${baselineFailures} pre-existing test failure(s) are confirmed on the base branch`);
  }
  const changed = hasDependencyChanges(dependencies)
    ? "Every version move below is derived from the diff itself."
    : "No dependency versions moved; the change is confined to target frameworks and code.";

  const head = [
    "## Dotnet upgrade agent workflow.",
    "",
    PR_PREAMBLE,
    "",
    "### ` Describe this PR `",
    "",
    "Automated upgrade of this repository to .NET 10 (LTS), opened by the dotnet10-upgrader loop.",
    "",
    "### ` What is the problem we're trying to solve? `",
    "",
    "This repository targeted a .NET release older than .NET 10 (LTS); this PR moves it onto the current LTS so it stays in support.",
    "",
    "### ` What changes have we introduced? `",
    "",
    `Target frameworks (and \`global.json\`, if present) moved to \`net10.0\`, NuGet references updated to net10.0-compatible stable versions, and the resulting build/test breaks fixed. ${tests} ${changed}`,
    "",
    GATE_CLAIMS,
    "",
    ...dependencySection(result.packageDecisions ?? [], dependencies, token, addedManifests),
    "",
    ...runSummarySection(result, token),
    "",
    "The agent's own summary of the run, quoted verbatim (untrusted repo output):",
    "",
  ].join("\n");

  const tail = [
    "",
    "#### ` Checklist `",
    "",
    ...checklist,
    "",
    "### ` Follow up actions after merging PR `",
    "",
    "None.",
  ].join("\n");

  const summary = redact(summaryText(result), token);
  const budget = Math.min(MAX_SUMMARY_CHARS, MAX_BODY_CHARS - head.length - tail.length - 64);
  const block =
    budget < MIN_SUMMARY_CHARS
      ? "_Run summary omitted: the sections above already fill GitHub's pull request body limit._"
      : fencedSummary(summary, budget);
  const body = `${head}${block}\n${tail}`;
  return body.length > MAX_BODY_CHARS ? `${body.slice(0, MAX_BODY_CHARS - 16)}\n…(truncated)` : body;
}

export type GitRunner = (args: string[], cwd: string, token: string, authenticate?: boolean) => string;

/** Manifests read per run; a bound on git calls, well above any real .NET repository. */
export const MAX_MANIFEST_FILES = 300;

function showBlob(runGit: GitRunner, cloneDir: string, token: string, spec: string): string | undefined {
  try {
    return runGit(["show", spec], cloneDir, token);
  } catch {
    // the blob does not exist on that side (added or deleted manifest)
    return undefined;
  }
}

/**
 * Ground truth for the PR's dependency table: compare each staged manifest against its HEAD
 * blob. HEAD is still baseSha here because the loop never commits, so this must run after
 * `git add -A` and before `git commit`.
 */
export function stagedManifests(stagedPaths: string[]): string[] {
  return stagedPaths
    // `git diff --name-only` quotes a path with non-ASCII bytes; `git show` wants the real one.
    .map((p) => unquoteGitPath(p))
    .filter((p) => p && !p.includes("\0"))
    .filter((p) => !isArtifactPath(p) && isPackageManifest(p));
}

/**
 * Manifests the staged diff touches that HEAD does not have: whole projects this change adds.
 * Their references read as `added` because there is no base blob to compare against, which is
 * not the same fact as a package appearing in a project that already existed.
 */
export function newManifests(
  cloneDir: string,
  token: string,
  stagedPaths: string[],
  runGit: GitRunner = git,
): string[] {
  return stagedManifests(stagedPaths).filter(
    (file) => showBlob(runGit, cloneDir, token, `HEAD:${file}`) === undefined,
  );
}

export function collectDependencyChanges(
  cloneDir: string,
  token: string,
  stagedPaths: string[],
  runGit: GitRunner = git,
): DependencyChanges {
  let changes = emptyDependencyChanges();
  const manifests = stagedManifests(stagedPaths);
  // Slicing here silently moved a manifest out of the scan window, and the window is ordered
  // by path: 320 filler projects under aaa/ pushed a smuggled package in zzz/ out of every
  // gate that reads this. Truncation is a refusal, as it is in the suppression scans.
  if (manifests.length > MAX_MANIFEST_FILES) {
    throw new OperatorError(
      `the staged diff touches ${manifests.length} package manifests, more than the ${MAX_MANIFEST_FILES} this scan reads; refusing to open a PR on a partial dependency scan`,
    );
  }
  for (const file of manifests) {
    const before = showBlob(runGit, cloneDir, token, `HEAD:${file}`);
    const after = showBlob(runGit, cloneDir, token, `:${file}`);
    if (before === undefined && after === undefined) continue;
    changes = mergeDependencyChanges(changes, diffManifests(before ?? "", after ?? "", file));
  }
  // Capping here silently moved rows out of the scan: 300 manifests at one reference each
  // overflow the 200-row table, and `unexplainedAdditions` reads the capped set, so an
  // unexplained addition past the cap shipped without the gate ever seeing it. Truncation is
  // a refusal, as it is in the suppression and test-weakening scans.
  const rows =
    changes.packages.length + changes.frameworks.length + changes.sdks.length + changes.images.length;
  if (rows > MAX_DEPENDENCY_ROWS) {
    throw new OperatorError(
      `the staged diff carries ${rows} dependency rows, more than the ${MAX_DEPENDENCY_ROWS} this scan reads; refusing to open a PR on a partial dependency scan`,
    );
  }
  return capDependencyChanges(changes);
}

/** Package references the base branch did not have. Derived from the diff, like the table. */
export function addedPackages(dependencies: DependencyChanges): PackageChange[] {
  return dependencies.packages.filter((change) => change.kind === "added");
}

function hasAddedEvidence(decisions: PackageDecision[], pkg: string): boolean {
  const key = pkg.trim().toLowerCase();
  return decisions.some((d) => d.package.trim().toLowerCase() === key && (d.evidence ?? "").trim() !== "");
}

/** Whether a path is one of the manifests this change adds, compared the way git reports it. */
function isNewManifest(added: readonly string[], file: string): boolean {
  return added.some((p) => p === file);
}

/**
 * Added references the writer did not prove the upgrade needs. A new package belongs in the
 * diff only when the net10.0 build cannot pass without it, so the recorded decision has to
 * carry the restore or build error as evidence; anything else is an unexplained addition.
 *
 * References inside a manifest the change adds are exempt: a brand-new project has no HEAD
 * blob, so every reference it declares reads as `added`, and demanding a build error for each
 * leaves adding a project impossible except by recording evidence that does not exist — which
 * teaches the writer to fabricate the field this gate rests on. They are listed in the PR body
 * instead, where a human reviewer sees them.
 */
export function unexplainedAdditions(
  dependencies: DependencyChanges,
  decisions: PackageDecision[],
  addedManifests: readonly string[] = [],
): PackageChange[] {
  return addedPackages(dependencies).filter(
    (change) => !isNewManifest(addedManifests, change.file) && !hasAddedEvidence(decisions, change.package),
  );
}

/**
 * Warning suppressions the staged diff introduces. A warning that already fired on the base
 * branch was not introduced by the retarget, so silencing it here is out of scope.
 */
/**
 * The diff both scans read. `--text` is load-bearing: a `.gitattributes` on the base branch
 * marking `*.cs binary` reduces every source file to "Binary files … differ", and a scan with
 * no lines to read reports no findings at all.
 */
const STAGED_DIFF = ["diff", "--cached", "-U0", "--text"];

export function collectSuppressions(cloneDir: string, token: string, runGit: GitRunner = git): Suppression[] {
  const report = findSuppressions(runGit(STAGED_DIFF, cloneDir, token), isArtifactPath);
  if (report.truncated) {
    throw new OperatorError(
      "the staged diff adds more warning suppressions than the report holds; refusing to open a PR on a partial scan",
    );
  }
  return report.findings;
}

/**
 * Tests the staged diff disables, unregisters, or deletes. A green suite is the only evidence
 * the retarget preserved behaviour, so a change that stops a test reporting its failure is a
 * change to the evidence rather than to the code under test.
 */
export function collectTestWeakening(cloneDir: string, token: string, runGit: GitRunner = git): TestWeakening[] {
  const report = findTestWeakening(runGit(STAGED_DIFF, cloneDir, token), isArtifactPath);
  if (report.truncated) {
    // A partial report is the one thing a justification can silently cover: the entries it kept
    // are the ones the diff listed first, and the writer chooses the file names.
    throw new OperatorError(
      "the staged diff weakens more tests than the report holds; refusing to open a PR on a partial scan",
    );
  }
  return report.findings;
}

/**
 * Path form used to match a weakening to the entry claiming it; writers vary on separators and
 * on whether a repo-relative path is spelled with a leading `./`. A bare basename is
 * deliberately not accepted: `LedgerTests.cs` names as many files as the repository has test
 * projects, so matching on it would let an entry about one suite waive a deletion in another.
 */
function testChangePath(file: string): string {
  return file
    .trim()
    .replaceAll("\\", "/")
    .replace(/\/{2,}/g, "/")
    .replace(/^(?:\.\/)+/, "")
    .replace(/^\//, "")
    .toLowerCase();
}

/**
 * Weakenings no `testChanges` entry accounts for. The upgrade does legitimately change what a
 * few tests assert, so the escape hatch has to exist — but it is a recorded claim naming the
 * file, which a reviewer can check against the diff, not a silent deletion.
 */
export function unjustifiedTestWeakening(
  weakenings: TestWeakening[],
  changes: TestChange[],
): TestWeakening[] {
  const justified = new Set(
    changes.filter((c) => c.reason.trim() !== "").map((c) => testChangePath(c.file)),
  );
  return weakenings.filter((w) => !justified.has(testChangePath(w.file)));
}

/**
 * Whether the clone's HEAD is the commit the run was prepared at. A short manifest sha is
 * accepted as a prefix, which is how git itself resolves one.
 */
function isBaseCommit(headSha: string, baseSha: string): boolean {
  const head = headSha.trim().toLowerCase();
  const base = baseSha.trim().toLowerCase();
  return head === base || (base.length >= 7 && head.startsWith(base));
}

/**
 * Keep build output out of the commit without growing the exclude file on every retry: a
 * finalize that refuses and is run again appended the same block a second time.
 */
function excludeArtifacts(cloneDir: string): void {
  const excludeFile = path.join(cloneDir, ".git", "info", "exclude");
  fs.mkdirSync(path.dirname(excludeFile), { recursive: true });
  let existing = "";
  try {
    existing = fs.readFileSync(excludeFile, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const present = new Set(existing.split("\n").map((l) => l.trim()));
  const missing = ARTIFACT_EXCLUDES.filter((pattern) => !present.has(pattern));
  if (!missing.length) return;
  const lead = existing === "" || existing.endsWith("\n") ? "" : "\n";
  fs.appendFileSync(excludeFile, `${lead}${missing.join("\n")}\n`);
}

export async function finalizeRepo(
  octokit: Octokit,
  config: AppConfig,
  runId: string,
): Promise<UpgradeOutcome> {
  let logPath: string | undefined;
  const events: string[] = [`finalize run ${runId} at ${new Date().toISOString()}`];
  const note = (text: string): void => {
    events.push(text);
  };
  /** Set once the repo name is known and the log can be named; see writeLog. */
  let persistLog: (() => void) | undefined;
  /** Set once `git add -A` has run, so a refusal leaves the index as the loop left it. */
  let restoreIndex: (() => void) | undefined;

  const finish = (outcome: UpgradeOutcome): UpgradeOutcome => {
    persistLog?.();
    return { ...outcome, logPath };
  };
  const fail = (reason: string): UpgradeOutcome => {
    note(`REFUSED: ${reason}`);
    restoreIndex?.();
    return finish({ ok: false, reason: redact(reason, config.token), runId });
  };

  try {
    const workDir = resolveWorkDir(config.workDir);
    const dir = runDir(workDir, runId);
    const manifest = readManifest(dir);
    if (manifest.org !== config.org) {
      return fail(`manifest org ${JSON.stringify(manifest.org)} does not match config`);
    }
    if (manifest.runId !== runId) {
      return fail(`manifest runId ${JSON.stringify(manifest.runId)} does not match ${JSON.stringify(runId)}`);
    }
    assertManifestMatchesWorkDir(manifest, workDir);
    persistLog = () => {
      try {
        logPath = writeLog(workDir, manifest.repo, `${redact(events.join("\n"), config.token)}\n`);
      } catch {
        // the outcome is what matters; a log we cannot write must not mask it
      }
    };
    note(`repo=${manifest.repo} branch=${manifest.upgradeBranch} baseSha=${manifest.baseSha} phase=${manifest.phase}`);
    if (manifest.phase !== "loop-complete") {
      return fail(`run ${runId} is not loop-complete (phase ${manifest.phase})`);
    }

    // One read of result.json feeds both the gates and the digest: hashing a second read
    // would bind the manifest to a document finalize never reviewed.
    const gated = readRunResultBytes(dir, runId);
    const result = validateResult(gated.result, {
      repo: manifest.repo,
      branch: manifest.upgradeBranch,
      baseSha: manifest.baseSha,
    });
    const problems = finalizableProblems(result);
    if (problems.length) {
      return fail(`upgrade result is not finalizable: ${problems.join("; ")}`);
    }

    // `phase` is one string in a plain file in the run directory the writer also writes
    // result.json into, under the same UID: the 0600/0700 modes keep other users out, not the
    // party the rest of this function treats as untrusted. So the evidence check runs again
    // here rather than being inferred from the phase having been set.
    const roundLogsDigest = verifyRoundLogs(dir, runId, result);
    const resultDigest = sha256(gated.bytes);
    if (!manifest.resultDigest || !manifest.roundLogsDigest) {
      return fail(
        `run ${runId} carries no gate digest, so its evidence was never reviewed by complete-run; re-run \`npm run complete-run -- --run-id ${runId}\` and finalize after it passes`,
      );
    }
    if (manifest.resultDigest !== resultDigest) {
      return fail(
        `result.json changed after run ${runId} was gated: the manifest records sha256 ${manifest.resultDigest} and the file on disk hashes to ${resultDigest}. testChanges and packageDecisions waive a weakened test and a new package, so they have to be the entries the gate read; re-run complete-run to re-review the document finalize would ship`,
      );
    }
    if (manifest.roundLogsDigest !== roundLogsDigest) {
      return fail(
        `the round build/test logs changed after run ${runId} was gated: the manifest records sha256 ${manifest.roundLogsDigest} and the logs on disk hash to ${roundLogsDigest}; re-run complete-run to re-review the evidence finalize would rely on`,
      );
    }
    note(`evidence verified: result ${resultDigest.slice(0, 12)} logs ${roundLogsDigest.slice(0, 12)} round ${result.rounds}`);

    const cloneDir = assertCloneLayout(manifest.workDir, manifest.repo, manifest.cloneDir, true);
    writePrivateFile(path.join(cloneDir, ".git", "config"), readPristineGitConfig(dir));
    fs.rmSync(path.join(cloneDir, ".git", "hooks"), { recursive: true, force: true });

    const branch = manifest.upgradeBranch;
    const head = git(["rev-parse", "--abbrev-ref", "HEAD"], cloneDir, config.token).trim();
    if (head !== branch) {
      return fail(`expected HEAD on ${branch} after the loop, found ${head}`);
    }

    // Every gate below reads `git diff --cached`, which is HEAD against the index, while the
    // push sends the whole branch. Those are the same change only while HEAD is still the
    // commit the run was prepared at: a commit the loop made carries its contents past all
    // three gates and into the PR. Checked before `git add -A` so a refusal leaves the clone
    // exactly as the loop left it.
    const headSha = git(["rev-parse", "HEAD"], cloneDir, config.token).trim();
    if (!isBaseCommit(headSha, manifest.baseSha)) {
      return fail(
        `refusing to finalize run ${runId}: ${branch} is at ${headSha} but the run manifest records baseSha ${manifest.baseSha}, so the writer loop committed on the branch. The suppression, package-evidence and test-weakening gates read the staged diff against HEAD, so anything already committed would be pushed without ever being scanned. The loop must leave its work uncommitted; move the commits back into the working tree with \`git -C ${cloneDir} reset --soft ${manifest.baseSha}\` (then unstage with \`git reset\`) and finalize again`,
      );
    }

    excludeArtifacts(cloneDir);

    git(["add", "-A"], cloneDir, config.token);
    restoreIndex = () => {
      try {
        git(["reset", "-q"], cloneDir, config.token);
      } catch {
        // best effort: the refusal is what matters
      }
    };
    // `git diff --name-only` C-quotes a path with non-ASCII bytes under core.quotePath, so
    // `.github/wörkflow.yml` arrives as a quoted octal string and matches neither
    // `isForbiddenPath` nor `isArtifactPath` until it is unquoted.
    const staged = git(["diff", "--cached", "--name-only"], cloneDir, config.token)
      .split("\n")
      .map((l) => unquoteGitPath(l.trim()))
      .filter(Boolean);
    if (!staged.some((p) => !isArtifactPath(p))) {
      return fail("loop reported success but left no non-artifact changes");
    }
    const forbidden = staged.filter((p) => isForbiddenPath(p));
    if (forbidden.length) {
      return fail(`refusing to open a PR touching protected paths: ${forbidden.slice(0, 5).join(", ")}`);
    }

    const dependencies = collectDependencyChanges(cloneDir, config.token, staged);
    const addedManifests = newManifests(cloneDir, config.token, staged);

    // All three gates run before any of them refuses: a diff carrying a suppression, an
    // unexplained package and a deleted test is one review's worth of problems, and reporting
    // the first alone costs the operator three trips through the agent loop to learn them.
    const violations: string[] = [];
    const suppressions = collectSuppressions(cloneDir, config.token);
    if (suppressions.length) {
      const where = suppressions.slice(0, 5).map((s) => `${s.file} (${s.token}): ${s.line}`).join("; ");
      violations.push(`adds warning suppressions: ${where}`);
    }

    const unexplained = unexplainedAdditions(dependencies, result.packageDecisions ?? [], addedManifests);
    if (unexplained.length) {
      const where = unexplained.slice(0, 5).map((c) => `${c.package} in ${c.file}`).join(", ");
      violations.push(`adds package reference(s) with no recorded evidence: ${where}`);
    }

    const weakened = unjustifiedTestWeakening(
      collectTestWeakening(cloneDir, config.token),
      result.testChanges ?? [],
    );
    if (weakened.length) {
      const where = weakened.slice(0, 5).map((w) => `${w.file} (${w.token}): ${w.line}`).join("; ");
      violations.push(`weakens tests with no recorded reason: ${where}`);
    }
    if (violations.length) {
      const listed = violations.map((v, i) => `[${i + 1}] ${v}`).join(" ");
      return fail(`refusing to open a PR, ${violations.length} gate violation(s): ${listed}`);
    }

    /**
     * The pull request is open by the time this runs, so it is the outcome even if the phase
     * cannot be advanced — a run reported as failed while its PR is live sends the operator
     * looking for work that already landed.
     */
    const markFinalized = (prUrl: string): UpgradeOutcome => {
      try {
        transitionPhase(manifest, "finalized");
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e);
        note(`WARNING: the pull request is open but the run phase could not be advanced: ${why}`);
        return { ok: true, prUrl, runId, reason: redact(`pull request opened, but the run phase could not be advanced: ${why}`, config.token) };
      }
      return { ok: true, prUrl, runId };
    };

    note(`gates passed on ${staged.length} staged path(s); committing and pushing ${branch}`);
    git(["commit", "--no-verify", "-m", COMMIT_MESSAGE], cloneDir, config.token);
    git(["push", "--no-verify", "--", manifest.cloneUrl, `${branch}:${branch}`], cloneDir, config.token, true);

    let pr: { html_url: string };
    try {
      ({ data: pr } = await octokit.pulls.create({
        owner: config.org,
        repo: manifest.repo,
        title: COMMIT_MESSAGE,
        head: branch,
        base: manifest.defaultBranch,
        body: prBody(result, dependencies, config.token, addedManifests),
      }));
    } catch (e) {
      if ((e as { status?: number }).status === 422) {
        const { data: open } = await octokit.pulls.list({
          owner: config.org,
          repo: manifest.repo,
          head: `${config.org}:${branch}`,
          state: "open",
        });
        const existing = open[0];
        if (existing?.html_url) {
          note(`adopted the pull request already open for ${branch}: ${existing.html_url}`);
          return finish(markFinalized(existing.html_url));
        }
      } else {
        try {
          git(["push", "--delete", "--", manifest.cloneUrl, branch], cloneDir, config.token, true);
          note(`rolled back the pushed branch ${branch} after the pull request failed`);
        } catch {
          // best effort: the PR failure is the one worth reporting
        }
      }
      return fail(e instanceof Error ? e.message : String(e));
    }

    note(`opened ${pr.html_url}`);
    return finish(markFinalized(pr.html_url));
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

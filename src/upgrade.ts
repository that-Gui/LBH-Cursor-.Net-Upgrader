import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { retry } from "@octokit/plugin-retry";
import { throttling } from "@octokit/plugin-throttling";
import { Octokit } from "@octokit/rest";
import type { RepoReport } from "./inventory";

export type AppConfig = {
  org: string;
  token: string;
  workDir: string;
  batchSize: number;
  activeMonths: number;
  codeOwner?: string;
};

export function requireEnv(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const v = env[name]?.trim();
  if (!v) throw new Error(`missing required env var ${name}`);
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
    throw new Error(`invalid ${name}: ${raw} (expected an integer ${range})`);
  }
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const org = requireEnv("GITHUB_ORG", env);
  if (!ORG_NAME.test(org)) {
    throw new Error(`invalid GITHUB_ORG: ${JSON.stringify(org)}`);
  }
  const token = requireEnv("GITHUB_TOKEN", env);
  if (/\s/.test(token)) {
    throw new Error("invalid GITHUB_TOKEN: whitespace is not allowed");
  }
  const rawOwner = env.CODE_OWNERS?.trim();
  const codeOwner = !rawOwner || rawOwner === "0" ? undefined : rawOwner;
  if (codeOwner && /[\0\r\n]/.test(codeOwner)) {
    throw new Error("invalid CODE_OWNERS: control characters are not allowed");
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
    throw new Error(`refusing ${resolved} as WORK_DIR: pick a directory of its own`);
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
export const ARTIFACT_PATH = new RegExp(`(^|/)(${ARTIFACT_DIRS.join("|")})/|\\.binlog$`);
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
    throw new Error("invalid run manifest: cloneUrl must not start with -");
  }
  const expectedHttps = `https://github.com/${org}/${repo}.git`;
  if (cloneUrl === expectedHttps) return;
  if (!path.isAbsolute(cloneUrl)) {
    throw new Error(
      "invalid run manifest: cloneUrl must be the GitHub HTTPS URL or an absolute path under workDir",
    );
  }
  const resolved = path.resolve(cloneUrl);
  const work = path.resolve(workDir);
  if (!isStrictlyInside(work, resolved)) {
    throw new Error("invalid run manifest: cloneUrl path must be inside workDir");
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
      throw new Error("invalid run manifest: cloneUrl path must be inside workDir");
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
    throw new Error(`refusing repo with unexpected name: ${JSON.stringify(repo)}`);
  }
  const expected = expectedCloneDir(workDir, repo);
  const resolved = path.resolve(cloneDir);
  if (resolved !== expected) {
    throw new Error(`invalid run manifest: cloneDir must be ${expected}`);
  }
  try {
    fs.lstatSync(resolved);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      if (requireGit) throw new Error(`clone directory does not exist: ${resolved}`);
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
    throw new Error("invalid run manifest: cloneDir resolves outside the expected repo directory");
  }
  if (requireGit) {
    const gitDir = path.join(realClone, ".git");
    let gitSt: fs.Stats;
    try {
      gitSt = fs.lstatSync(gitDir);
    } catch {
      throw new Error("clone is missing a .git directory");
    }
    if (!gitSt.isDirectory()) {
      throw new Error("refusing clone whose .git is not a directory");
    }
  }
  return realClone;
}

export function assertManifestMatchesWorkDir(manifest: RunManifest, workDir: string): void {
  if (path.resolve(manifest.workDir) !== path.resolve(workDir)) {
    throw new Error("run manifest workDir does not match config WORK_DIR");
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
};

export type MarkerVerdict =
  | { ok: true; baselineFailures: number }
  | { ok: false; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function reqResultString(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  if (typeof v !== "string") throw new Error(`invalid upgrade result: ${key} must be a string`);
  return v;
}

function optString(obj: Record<string, unknown>, key: string): string | undefined {
  if (!(key in obj) || obj[key] === undefined) return undefined;
  const v = obj[key];
  if (typeof v !== "string") throw new Error(`invalid upgrade result: ${key} must be a string`);
  return v;
}

function reqBoolean(obj: Record<string, unknown>, key: string): boolean {
  const v = obj[key];
  if (typeof v !== "boolean") throw new Error(`invalid upgrade result: ${key} must be a boolean`);
  return v;
}

function reqInt(obj: Record<string, unknown>, key: string, min = 0): number {
  const v = obj[key];
  if (typeof v !== "number" || !Number.isInteger(v) || v < min) {
    throw new Error(`invalid upgrade result: ${key} must be an integer >= ${min}`);
  }
  return v;
}

function reqStringArray(obj: Record<string, unknown>, key: string): string[] {
  const v = obj[key];
  if (!Array.isArray(v) || v.some((item) => typeof item !== "string")) {
    throw new Error(`invalid upgrade result: ${key} must be an array of strings`);
  }
  return v;
}

function parseFinding(value: unknown, findingPath: string): Finding {
  if (!isRecord(value)) throw new Error(`invalid upgrade result: ${findingPath} must be an object`);
  const severity = value.severity;
  if (severity !== "critical" && severity !== "warning" && severity !== "suggestion") {
    throw new Error(`invalid upgrade result: ${findingPath}.severity is invalid`);
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
  if (!Array.isArray(v)) throw new Error(`invalid upgrade result: ${key} must be an array`);
  return v.map((item, i) => parseFinding(item, `${key}[${i}]`));
}

export function parseUpgradeResult(value: unknown): UpgradeResult {
  if (!isRecord(value)) throw new Error("invalid upgrade result: expected an object");
  if (value.schemaVersion !== RESULT_SCHEMA_VERSION) {
    throw new Error(`invalid upgrade result: schemaVersion must be ${RESULT_SCHEMA_VERSION}`);
  }
  const reviewers = value.reviewers;
  if (reviewers !== "PASS" && reviewers !== "FAIL") {
    throw new Error("invalid upgrade result: reviewers must be PASS or FAIL");
  }
  const upgradeResult = value.upgradeResult;
  if (upgradeResult !== "SUCCESS" && upgradeResult !== "FAILED") {
    throw new Error("invalid upgrade result: upgradeResult must be SUCCESS or FAILED");
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

export function isFinalizable(result: UpgradeResult): boolean {
  return (
    result.schemaVersion === RESULT_SCHEMA_VERSION &&
    result.reviewers === "PASS" &&
    result.upgradeResult === "SUCCESS" &&
    result.buildPassed === true &&
    result.testsRegressed === false &&
    result.unresolvedCriticals.length === 0 &&
    Number.isInteger(result.baselineFailures) &&
    result.baselineFailures >= 0
  );
}

export function validateResult(
  value: unknown,
  expected: { repo: string; branch: string; baseSha: string },
): UpgradeResult {
  const result = parseUpgradeResult(value);
  if (result.repo !== expected.repo || result.branch !== expected.branch || result.baseSha !== expected.baseSha) {
    throw new Error(
      `upgrade result identity mismatch: got repo=${JSON.stringify(result.repo)} branch=${JSON.stringify(result.branch)} baseSha=${JSON.stringify(result.baseSha)}`,
    );
  }
  return result;
}

export function summaryText(result: UpgradeResult): string {
  const markers = [
    `BASELINE_FAILURES: ${result.baselineFailures}`,
    `REVIEWERS: ${result.reviewers}`,
    `UPGRADE_RESULT: ${result.upgradeResult}`,
  ].join("\n");
  const body = result.implementationSummary.trimEnd();
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
};

const PHASES: readonly RunPhase[] = ["prepared", "loop-complete", "finalized", "failed"];

const ALLOWED_TRANSITIONS: Record<RunPhase, readonly RunPhase[]> = {
  prepared: ["loop-complete", "failed"],
  "loop-complete": ["finalized", "failed"],
  failed: ["failed"],
  finalized: ["finalized"],
};

function reqManifestString(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  if (typeof v !== "string" || !v) throw new Error(`invalid run manifest: ${key} must be a non-empty string`);
  return v;
}

function parseManifest(value: unknown): RunManifest {
  if (!isRecord(value)) throw new Error("invalid run manifest: expected an object");
  if (value.schemaVersion !== RUN_SCHEMA_VERSION) {
    throw new Error(`invalid run manifest: schemaVersion must be ${RUN_SCHEMA_VERSION}`);
  }
  const phase = value.phase;
  if (typeof phase !== "string" || !(PHASES as readonly string[]).includes(phase)) {
    throw new Error("invalid run manifest: phase is invalid");
  }
  const cloneDir = reqManifestString(value, "cloneDir");
  const workDir = reqManifestString(value, "workDir");
  if (!path.isAbsolute(cloneDir) || !path.isAbsolute(workDir)) {
    throw new Error("invalid run manifest: cloneDir and workDir must be absolute");
  }
  const runId = reqManifestString(value, "runId");
  const org = reqManifestString(value, "org");
  const repo = reqManifestString(value, "repo");
  const defaultBranch = reqManifestString(value, "defaultBranch");
  const upgradeBranch = reqManifestString(value, "upgradeBranch");
  const baseSha = reqManifestString(value, "baseSha");
  const cloneUrl = reqManifestString(value, "cloneUrl");
  if (!isSafeName(runId)) throw new Error(`invalid runId: ${JSON.stringify(runId)}`);
  if (!ORG_NAME.test(org)) throw new Error(`invalid run manifest: org is invalid`);
  if (!isSafeName(repo)) throw new Error(`refusing repo with unexpected name: ${JSON.stringify(repo)}`);
  if (!isSafeDefaultBranch(defaultBranch)) throw new Error("invalid run manifest: defaultBranch is invalid");
  if (!UPGRADE_BRANCH.test(upgradeBranch)) throw new Error("invalid run manifest: upgradeBranch is invalid");
  if (!GIT_SHA.test(baseSha)) throw new Error("invalid run manifest: baseSha is invalid");
  assertCloneLayout(workDir, repo, cloneDir);
  assertSafeCloneUrl(org, repo, cloneUrl, workDir);
  return {
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
}

export function runDir(workDir: string, runId: string): string {
  if (!isSafeName(runId)) {
    throw new Error(`invalid runId: ${JSON.stringify(runId)}`);
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

export function transitionPhase(manifest: RunManifest, next: RunPhase): RunManifest {
  const allowed = ALLOWED_TRANSITIONS[manifest.phase];
  if (!allowed.includes(next)) {
    throw new Error(`illegal phase transition: ${manifest.phase} -> ${next}`);
  }
  const updated: RunManifest = { ...manifest, phase: next };
  writeManifest(runDir(manifest.workDir, manifest.runId), updated);
  return updated;
}

export function assertResultIdentity(manifest: RunManifest, result: UpgradeResult): void {
  if (result.repo !== manifest.repo || result.branch !== manifest.upgradeBranch || result.baseSha !== manifest.baseSha) {
    throw new Error(
      `result identity does not match run ${manifest.runId}: expected repo=${manifest.repo} branch=${manifest.upgradeBranch} baseSha=${manifest.baseSha}`,
    );
  }
}

/** Advance prepared → loop-complete after a finalizable result.json is on disk. */
export function markLoopComplete(workDir: string, runId: string): RunManifest {
  const dir = runDir(workDir, runId);
  const manifest = readManifest(dir);
  assertManifestMatchesWorkDir(manifest, workDir);
  const result = readResult(dir);
  assertResultIdentity(manifest, result);
  if (!isFinalizable(result)) {
    throw new Error(`run ${runId} result is not finalizable`);
  }
  if (manifest.phase === "loop-complete") return manifest;
  return transitionPhase(manifest, "loop-complete");
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
    throw new Error("refusing WORK_DIR whose repos/ resolves outside the work directory");
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

export function prBody(summary: string, token: string, baselineFailures: number): string {
  const safe = redact(summary, token);
  const clipped = safe.length > MAX_SUMMARY_CHARS ? `${safe.slice(0, MAX_SUMMARY_CHARS)}\n…(truncated)` : safe;
  const longest = Math.max(0, ...[...clipped.matchAll(/`+/g)].map((m) => m[0]?.length ?? 0));
  const fence = "`".repeat(Math.max(3, longest + 1));
  const details = `<details>\n<summary>Agent run summary</summary>\n\n${fence}text\n${clipped}\n${fence}\n\n</details>`;
  const tests =
    baselineFailures === 0
      ? "`dotnet build` and `dotnet test` both pass — the loop opens no PR otherwise."
      : `\`dotnet build\` passes. ${baselineFailures} test(s) were already failing on the base branch before this change and still fail, unchanged; no test that was passing now fails — the loop opens no PR otherwise.`;
  const checklist = ["- [ ] Code pipeline builds correctly"];
  if (baselineFailures > 0) {
    checklist.push(`- [ ] The ${baselineFailures} pre-existing test failure(s) are confirmed on the base branch`);
  }
  return [
    "## [Dotnet upgrade agent workflow.]()",
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
    `Target frameworks (and \`global.json\`, if present) moved to \`net10.0\`, NuGet references updated to net10.0-compatible stable versions, and the resulting build/test breaks fixed. ${tests} The agent's full run summary (untrusted repo output, quoted verbatim):`,
    "",
    details,
    "",
    "#### ` Checklist `",
    "",
    ...checklist,
    "",
    "### ` Follow up actions after merging PR `",
    "",
    "None.",
  ].join("\n");
}

export async function finalizeRepo(
  octokit: Octokit,
  config: AppConfig,
  runId: string,
): Promise<UpgradeOutcome> {
  let logPath: string | undefined;
  const fail = (reason: string): UpgradeOutcome => ({
    ok: false,
    reason: redact(reason, config.token),
    logPath,
    runId,
  });

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
    logPath = path.join(workDir, "logs", `${manifest.repo}.log`);
    if (manifest.phase !== "loop-complete") {
      return fail(`run ${runId} is not loop-complete (phase ${manifest.phase})`);
    }

    const cloneDir = assertCloneLayout(manifest.workDir, manifest.repo, manifest.cloneDir, true);
    writePrivateFile(path.join(cloneDir, ".git", "config"), readPristineGitConfig(dir));
    fs.rmSync(path.join(cloneDir, ".git", "hooks"), { recursive: true, force: true });

    const excludeFile = path.join(cloneDir, ".git", "info", "exclude");
    fs.mkdirSync(path.dirname(excludeFile), { recursive: true });
    fs.appendFileSync(excludeFile, `\n${ARTIFACT_EXCLUDES.join("\n")}\n`);

    const result = validateResult(readResult(dir), {
      repo: manifest.repo,
      branch: manifest.upgradeBranch,
      baseSha: manifest.baseSha,
    });
    if (!isFinalizable(result)) {
      return fail("upgrade result is not finalizable");
    }

    const branch = manifest.upgradeBranch;
    const head = git(["rev-parse", "--abbrev-ref", "HEAD"], cloneDir, config.token).trim();
    if (head !== branch) {
      return fail(`expected HEAD on ${branch} after the loop, found ${head}`);
    }

    git(["add", "-A"], cloneDir, config.token);
    const staged = git(["diff", "--cached", "--name-only"], cloneDir, config.token)
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    if (!staged.some((p) => !isArtifactPath(p))) {
      return fail("loop reported success but left no non-artifact changes");
    }
    const forbidden = staged.filter((p) => isForbiddenPath(p));
    if (forbidden.length) {
      return fail(`refusing to open a PR touching protected paths: ${forbidden.slice(0, 5).join(", ")}`);
    }

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
        body: prBody(summaryText(result), config.token, result.baselineFailures),
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
          transitionPhase(manifest, "finalized");
          return { ok: true, prUrl: existing.html_url, runId, logPath };
        }
      } else {
        try {
          git(["push", "--delete", "--", manifest.cloneUrl, branch], cloneDir, config.token, true);
        } catch {
          // best effort: the PR failure is the one worth reporting
        }
      }
      return fail(e instanceof Error ? e.message : String(e));
    }

    transitionPhase(manifest, "finalized");
    return { ok: true, prUrl: pr.html_url, runId, logPath };
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

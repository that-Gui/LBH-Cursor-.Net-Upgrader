import path from "node:path";
import { buildInventory, formatInventory, upgradeQueue } from "./inventory";
import {
  createOctokit,
  finalizeRepo,
  loadConfig,
  markLoopComplete,
  OperatorError,
  prepareRepo,
  redact,
  resolveWorkDir,
  type AppConfig,
} from "./upgrade";

const COMMAND_USAGE = [
  "usage: tsx src/main.ts <inventory|select|prepare|complete|finalize> [...args]",
  "",
  "  inventory [--json]     classify the org's repos and print the upgrade queue",
  "  select                 the first BATCH_SIZE needs-upgrade reports, as JSON",
  "  prepare --repo NAME    clone NAME onto an upgrade branch and write a run manifest",
  "  complete --run-id ID   advance a run to loop-complete after the loop writes result.json",
  "  finalize --run-id ID   apply the gates, push, and open the pull request",
].join("\n");

const ENV_USAGE = [
  "environment:",
  "  GITHUB_ORG      required (not by complete): the organisation to scan",
  "  GITHUB_TOKEN    required (not by complete): a token with repo and pull request access",
  "  WORK_DIR        optional: where clones and run state live (default ./work)",
  "  BATCH_SIZE      optional: repos per select, 1-32 (default 4)",
  "  ACTIVE_MONTHS   optional: ignore repos with no push in that many months, 1-120 (default 12)",
  "  CODE_OWNERS     optional: only repos whose CODEOWNERS names this owner (unset or 0 scans all)",
].join("\n");

const USAGE = `${COMMAND_USAGE}\n\n${ENV_USAGE}`;

/** Mirrors the WORK_DIR default loadConfig applies; complete reads the environment without it. */
const DEFAULT_WORK_DIR = "./work";

type Command = "inventory" | "select" | "prepare" | "complete" | "finalize";

function argv(): string[] {
  return process.argv.slice(3);
}

function hasFlag(name: string): boolean {
  return argv().includes(name);
}

function flagValue(name: string): string | undefined {
  const args = argv();
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const v = args[i + 1];
  if (v === undefined || v.startsWith("--")) return undefined;
  return v;
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

let token = process.env.GITHUB_TOKEN?.trim() ?? "";

/**
 * The two ways this CLI reports a failure. Which one an error gets is not inferred from its
 * shape: src/upgrade.ts marks the failures whose message is written for the operator by throwing
 * OperatorError, and everything else — a bug here, a broken invariant, a syscall error — reaches
 * `die`, where the stack is the only thing that locates it.
 */
function die(e: unknown): never {
  if (e instanceof OperatorError) fail(e.message);
  const message = e instanceof Error ? (e.stack ?? e.message) : String(e);
  console.error(redact(message, token));
  process.exit(1);
}
process.on("unhandledRejection", die);
process.on("uncaughtException", die);

/** A failure the operator can act on: the message, and the usage text that says how. */
function fail(message: string, help?: string): never {
  console.error(redact(message, token));
  if (help) console.error(help);
  process.exit(1);
}

/** The file an ENOENT is about, so the caller can say what should have written it. */
function missingFile(e: unknown): string | undefined {
  const err = e as NodeJS.ErrnoException;
  return e instanceof Error && err.code === "ENOENT" ? err.path : undefined;
}

function requiredFlag(command: Command, name: "--repo" | "--run-id", placeholder: string): string {
  const value = flagValue(name);
  if (!value) fail(`${command} requires ${name} ${placeholder}`, COMMAND_USAGE);
  return value;
}

function config(): AppConfig {
  try {
    return loadConfig();
  } catch (e) {
    if (!(e instanceof OperatorError)) throw e;
    return fail(e.message, ENV_USAGE);
  }
}

/** complete only touches files under WORK_DIR, so it must not demand GitHub credentials. */
function workDir(): string {
  try {
    return resolveWorkDir(process.env.WORK_DIR?.trim() || DEFAULT_WORK_DIR);
  } catch (e) {
    if (!(e instanceof OperatorError)) throw e;
    return fail(e.message, ENV_USAGE);
  }
}

function inventoryOpts(cfg: AppConfig) {
  return { org: cfg.org, activeMonths: cfg.activeMonths, codeOwner: cfg.codeOwner };
}

async function inventory(cfg: AppConfig): Promise<number> {
  const reports = await buildInventory(createOctokit(cfg.token), inventoryOpts(cfg));
  if (hasFlag("--json")) {
    printJson(reports);
  } else {
    console.log(formatInventory(reports));
  }
  return 0;
}

async function select(cfg: AppConfig): Promise<number> {
  const reports = await buildInventory(createOctokit(cfg.token), inventoryOpts(cfg));
  const batch = upgradeQueue(reports).slice(0, cfg.batchSize);
  printJson(batch);
  console.error(`selected ${batch.length}`);
  return 0;
}

async function prepare(cfg: AppConfig, name: string): Promise<number> {
  const octokit = createOctokit(cfg.token);
  const reports = await buildInventory(octokit, inventoryOpts(cfg));
  const report = upgradeQueue(reports).find((r) => r.name === name);
  if (!report) {
    const known = reports.find((r) => r.name === name);
    const reason = known
      ? `repo ${name} is classified ${known.classification}, not needs-upgrade`
      : `repo ${name} was not found in the upgrade queue`;
    console.error(redact(reason, cfg.token));
    return 1;
  }
  const manifest = await prepareRepo(octokit, cfg, report);
  printJson(manifest);
  return 0;
}

/**
 * Local file work only: the run directory is on disk and markLoopComplete never calls GitHub.
 * The likeliest mistake is completing a run that was never prepared, which reaches here as a
 * bare ENOENT on the manifest; name the step that writes it instead.
 */
function complete(runId: string): number {
  const dir = workDir();
  try {
    printJson(markLoopComplete(dir, runId));
    return 0;
  } catch (e) {
    const missing = missingFile(e);
    if (missing && path.basename(missing) === "manifest.json") {
      fail(`no run ${runId} under ${dir}: prepare --repo NAME writes the run manifest (expected at ${missing})`);
    }
    if (e instanceof OperatorError) fail(e.message);
    throw e;
  }
}

async function finalize(cfg: AppConfig, runId: string): Promise<number> {
  const outcome = await finalizeRepo(createOctokit(cfg.token), cfg, runId);
  printJson(outcome);
  return outcome.ok ? 0 : 1;
}

async function main(): Promise<number> {
  const sub = process.argv[2];
  if (sub === "--help" || sub === "-h" || sub === "help") {
    console.log(USAGE);
    return 0;
  }
  if (
    sub !== "inventory" &&
    sub !== "select" &&
    sub !== "prepare" &&
    sub !== "complete" &&
    sub !== "finalize"
  ) {
    fail(sub ? `unknown command ${JSON.stringify(sub)}` : "no command given", USAGE);
  }
  const cmd: Command = sub;
  if (hasFlag("--help") || hasFlag("-h")) {
    console.log(USAGE);
    return 0;
  }

  // Arguments are checked before the environment so a missing flag reports the flag.
  if (cmd === "complete") return complete(requiredFlag(cmd, "--run-id", "ID"));
  const repo = cmd === "prepare" ? requiredFlag(cmd, "--repo", "NAME") : "";
  const runId = cmd === "finalize" ? requiredFlag(cmd, "--run-id", "ID") : "";

  const cfg = config();
  token = cfg.token;
  if (cmd === "inventory") return inventory(cfg);
  if (cmd === "select") return select(cfg);
  if (cmd === "prepare") return prepare(cfg, repo);
  return finalize(cfg, runId);
}

main().then((code) => process.exit(code), die);

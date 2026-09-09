import { buildInventory, formatInventory, upgradeQueue } from "./inventory";
import {
  createOctokit,
  finalizeRepo,
  loadConfig,
  markLoopComplete,
  prepareRepo,
  redact,
  resolveWorkDir,
  type AppConfig,
} from "./upgrade";

const USAGE = "usage: tsx src/main.ts <inventory|select|prepare|complete|finalize> [...args]";
type Command = "inventory" | "select" | "prepare" | "complete" | "finalize";

const sub = process.argv[2];
if (
  sub !== "inventory" &&
  sub !== "select" &&
  sub !== "prepare" &&
  sub !== "complete" &&
  sub !== "finalize"
) {
  console.error(USAGE);
  process.exit(1);
}
const cmd: Command = sub;

let token = process.env.GITHUB_TOKEN?.trim() ?? "";
const die = (e: unknown): never => {
  const message = e instanceof Error ? (e.stack ?? e.message) : String(e);
  console.error(redact(message, token));
  process.exit(1);
};
process.on("unhandledRejection", die);
process.on("uncaughtException", die);

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

async function run(command: Command, config: AppConfig): Promise<number> {
  const octokit = createOctokit(config.token);
  const inventoryOpts = { org: config.org, activeMonths: config.activeMonths, codeOwner: config.codeOwner };

  if (command === "inventory") {
    const reports = await buildInventory(octokit, inventoryOpts);
    if (hasFlag("--json")) {
      printJson(reports);
    } else {
      console.log(formatInventory(reports));
    }
    return 0;
  }

  if (command === "select") {
    const reports = await buildInventory(octokit, inventoryOpts);
    const batch = upgradeQueue(reports).slice(0, config.batchSize);
    printJson(batch);
    console.error(`selected ${batch.length}`);
    return 0;
  }

  if (command === "prepare") {
    const name = flagValue("--repo");
    if (!name) {
      console.error("prepare requires --repo NAME");
      console.error(USAGE);
      return 1;
    }
    const reports = await buildInventory(octokit, inventoryOpts);
    const report = upgradeQueue(reports).find((r) => r.name === name);
    if (!report) {
      const known = reports.find((r) => r.name === name);
      const reason = known
        ? `repo ${name} is classified ${known.classification}, not needs-upgrade`
        : `repo ${name} was not found in the upgrade queue`;
      console.error(redact(reason, config.token));
      return 1;
    }
    const manifest = await prepareRepo(octokit, config, report);
    printJson(manifest);
    return 0;
  }

  const runId = flagValue("--run-id");
  if (!runId) {
    console.error(`${command} requires --run-id ID`);
    console.error(USAGE);
    return 1;
  }

  if (command === "complete") {
    const manifest = markLoopComplete(resolveWorkDir(config.workDir), runId);
    printJson(manifest);
    return 0;
  }

  const outcome = await finalizeRepo(octokit, config, runId);
  printJson(outcome);
  return outcome.ok ? 0 : 1;
}

async function main(): Promise<number> {
  const config = loadConfig();
  token = config.token;
  return run(cmd, config);
}

main().then((code) => process.exit(code), die);

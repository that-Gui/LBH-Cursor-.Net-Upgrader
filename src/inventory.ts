import type { Octokit } from "@octokit/rest";

export type Classification =
  | "needs-upgrade"
  | "up-to-date"
  | "framework"
  | "netstandard-only"
  | "no-dotnet"
  | "incomplete";

export type RepoReport = {
  name: string;
  defaultBranch: string;
  pushedAt: string;
  classification: Classification;
  tfms: string[];
  sdkVersion?: string;
  projectFileCount: number;
};

export type InventoryOpts = { org: string; activeMonths: number; codeOwner?: string };

export const PROJECT_FILE = /\.(cs|fs|vb)proj$/i;
export const SPECIAL_FILE = /(^|\/)(Directory\.Build\.props|global\.json)$/i;
export const CODEOWNERS_FILE = /^(?:\.github\/|docs\/)?CODEOWNERS$/;
export const MAX_FETCHES_PER_REPO = 30;
export const MAX_FILE_BYTES = 1_000_000;
export const MAX_PARSE_CHARS = 200_000;

const isInteresting = (p: string) => PROJECT_FILE.test(p) || SPECIAL_FILE.test(p);

export async function buildInventory(octokit: Octokit, opts: InventoryOpts): Promise<RepoReport[]> {
  const cutoff = new Date();
  cutoff.setDate(1);
  cutoff.setMonth(cutoff.getMonth() - opts.activeMonths);
  const repos = await octokit.paginate(octokit.repos.listForOrg, { org: opts.org, per_page: 100 });
  const reports: RepoReport[] = [];
  for (const repo of repos) {
    if (repo.archived || repo.disabled || !repo.default_branch) continue;
    if (!repo.pushed_at || new Date(repo.pushed_at) < cutoff) continue;
    if (!/^[A-Za-z0-9._-]+$/.test(repo.name) || repo.name === "." || repo.name === "..") continue;
    const report = await inspectRepo(octokit, opts.org, repo.name, repo.default_branch, repo.pushed_at, opts.codeOwner);
    if (report) reports.push(report);
  }
  return reports;
}

const normalizeOwner = (s: string) => s.replace(/^@/, "").toLowerCase();

export function ownsRepo(codeowners: string, owner: string): boolean {
  const want = normalizeOwner(owner);
  return codeowners
    .slice(0, MAX_PARSE_CHARS)
    .split("\n")
    .map((l) => l.split("#")[0]?.trim() ?? "")
    .flatMap((l) => l.split(/\s+/).slice(1))
    .some((t) => normalizeOwner(t) === want);
}

export function upgradeQueue(reports: RepoReport[]): RepoReport[] {
  return reports
    .filter((r) => r.classification === "needs-upgrade")
    .sort((a, b) => a.projectFileCount - b.projectFileCount);
}

export async function inspectRepo(
  octokit: Octokit,
  org: string,
  name: string,
  defaultBranch: string,
  pushedAt: string,
  codeOwner?: string,
): Promise<RepoReport | undefined> {
  let paths: string[] = [];
  let projectFileCount = 0;
  let incomplete = false;
  let codeownersPath: string | undefined;
  try {
    const { data } = await octokit.git.getTree({ owner: org, repo: name, tree_sha: defaultBranch, recursive: "1" });
    if (data.truncated) console.error(`warning: ${name}: git tree truncated; classification may be incomplete`);
    const blobs = data.tree.filter((e) => e.type === "blob");
    projectFileCount = blobs.filter((e) => PROJECT_FILE.test(e.path ?? "")).length;
    const interesting = blobs.filter((e) => isInteresting(e.path ?? ""));
    const readable = interesting.filter((e) => (e.size ?? 0) <= MAX_FILE_BYTES);
    paths = readable.map((e) => e.path ?? "").slice(0, MAX_FETCHES_PER_REPO);
    codeownersPath = blobs.find((e) => CODEOWNERS_FILE.test(e.path ?? "") && (e.size ?? 0) <= MAX_FILE_BYTES)?.path;
    incomplete = Boolean(data.truncated) || readable.length < interesting.length || paths.length < readable.length;
  } catch (e) {
    const status = (e as { status?: number }).status;
    if (status !== 404 && status !== 409) throw e;
  }

  if (codeOwner) {
    const owners = codeownersPath && (await fetchText(octokit, org, name, codeownersPath, defaultBranch));
    if (!owners || !ownsRepo(owners, codeOwner)) return undefined;
  }

  const tfms: string[] = [];
  let sdkVersion: string | undefined;
  const texts = await Promise.all(paths.map((p) => fetchText(octokit, org, name, p, defaultBranch)));
  for (const [i, p] of paths.entries()) {
    const text = texts[i]?.slice(0, MAX_PARSE_CHARS);
    if (text === undefined) continue;
    if (/global\.json$/i.test(p)) {
      try {
        const v = JSON.parse(text)?.sdk?.version;
        if (typeof v === "string") sdkVersion = v;
      } catch {
        // malformed global.json: ignore
      }
    } else {
      for (const m of text.matchAll(/<TargetFrameworks?(?:\s[^>]*)?>([^<]+)<\/TargetFrameworks?>/gi)) {
        const captured = m[1];
        if (!captured) continue;
        tfms.push(...captured.split(";").map((t) => t.trim()).filter(Boolean));
      }
    }
  }

  const classification = classify(tfms, sdkVersion);
  return {
    name,
    defaultBranch,
    pushedAt,
    classification: incomplete && classification === "needs-upgrade" ? "incomplete" : classification,
    tfms: [...new Set(tfms)],
    sdkVersion,
    projectFileCount,
  };
}

async function fetchText(
  octokit: Octokit,
  owner: string,
  repo: string,
  path: string,
  ref: string,
): Promise<string | undefined> {
  try {
    const { data } = await octokit.repos.getContent({ owner, repo, path, ref, mediaType: { format: "raw" } });
    return typeof data === "string" ? data : undefined;
  } catch (e) {
    if ((e as { status?: number }).status === 404) return undefined;
    throw e;
  }
}

export function classify(tfms: string[], sdkVersion: string | undefined): Classification {
  if (tfms.some((t) => /^net4\d/i.test(t))) return "framework";
  const majors: number[] = [];
  for (const t of tfms) {
    const m = /^net(coreapp)?(\d+)\.\d+/i.exec(t);
    if (m && (m[1] || Number(m[2]) >= 5)) majors.push(Number(m[2]));
  }
  const sdkMajor = parseInt(sdkVersion ?? "", 10);
  if (!Number.isNaN(sdkMajor)) majors.push(sdkMajor);
  if (majors.length) return Math.max(...majors) >= 10 ? "up-to-date" : "needs-upgrade";
  return tfms.some((t) => /^netstandard/i.test(t)) ? "netstandard-only" : "no-dotnet";
}

export function formatInventory(reports: RepoReport[]): string {
  const queue = upgradeQueue(reports);
  const lines: string[] = [`Upgrade queue (${queue.length}):`];
  for (const r of queue) {
    const targets = r.tfms.concat(r.sdkVersion ? [`sdk ${r.sdkVersion}`] : []).join(", ") || "(none)";
    lines.push(`  ${r.name}  [${targets}]  ${r.projectFileCount} project file(s)  last push ${r.pushedAt.slice(0, 10)}`);
  }
  const names = (c: Classification) =>
    reports.filter((r) => r.classification === c).map((r) => r.name).join(", ") || "(none)";
  lines.push(`Excluded — .NET Framework: ${names("framework")}`);
  lines.push(`Excluded — netstandard-only: ${names("netstandard-only")}`);
  lines.push(`Excluded — incomplete scan: ${names("incomplete")}`);
  return lines.join("\n");
}

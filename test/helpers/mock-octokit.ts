import type { Octokit } from "@octokit/rest";

export type MockBlob = {
  type?: "blob" | "tree";
  path: string;
  size?: number;
  content?: string;
};

export type MockRepo = {
  name: string;
  archived?: boolean;
  disabled?: boolean;
  default_branch?: string | null;
  pushed_at?: string | null;
  truncated?: boolean;
  tree?: MockBlob[];
  files?: Record<string, string>;
};

function notFound(): never {
  throw Object.assign(new Error("Not Found"), { status: 404 });
}

/** Minimal Octokit stub: paginate + getTree + getContent, no network. */
export function mockOctokit(repos: MockRepo[]): Octokit {
  const byName = new Map(repos.map((r) => [r.name, r]));
  return {
    paginate: async () =>
      repos.map((r) => ({
        name: r.name,
        archived: r.archived ?? false,
        disabled: r.disabled ?? false,
        default_branch: r.default_branch === undefined ? "main" : r.default_branch,
        pushed_at: r.pushed_at === undefined ? new Date().toISOString() : r.pushed_at,
      })),
    repos: {
      listForOrg: {},
      getContent: async ({ repo, path }: { repo: string; path: string }) => {
        const r = byName.get(repo);
        if (!r) notFound();
        const fromTree = r.tree?.find((e) => e.path === path)?.content;
        const data = r.files?.[path] ?? fromTree;
        if (data === undefined) notFound();
        return { data };
      },
    },
    git: {
      getTree: async ({ repo }: { repo: string }) => {
        const r = byName.get(repo);
        if (!r) notFound();
        return {
          data: {
            truncated: Boolean(r.truncated),
            tree: (r.tree ?? []).map((e) => ({
              type: e.type ?? "blob",
              path: e.path,
              size: e.size ?? e.content?.length ?? 100,
            })),
          },
        };
      },
    },
  } as unknown as Octokit;
}

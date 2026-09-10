/**
 * Diff-derived dependency facts for the PR body. Everything here is a pure function over
 * two blob contents, so the PR table states what the diff says rather than what the agent
 * claims: the agent only supplies the reason column.
 */

/** Blobs above this size are not worth parsing (lock files, vendored data). */
export const MAX_MANIFEST_BYTES = 1_048_576;
/** Hard cap on rows rendered in the PR table. */
export const MAX_DEPENDENCY_ROWS = 200;

export type ChangeKind = "added" | "removed" | "changed";

export type PackageChange = {
  file: string;
  package: string;
  from?: string;
  to?: string;
  kind: ChangeKind;
};

export type FrameworkChange = {
  file: string;
  from?: string;
  to?: string;
  kind: ChangeKind;
};

export type SdkChange = {
  file: string;
  from?: string;
  to?: string;
  kind: ChangeKind;
};

export type ImageChange = {
  file: string;
  image: string;
  from?: string;
  to?: string;
  kind: ChangeKind;
};

export type DependencyChanges = {
  packages: PackageChange[];
  frameworks: FrameworkChange[];
  sdks: SdkChange[];
  images: ImageChange[];
  /** Rows dropped by MAX_DEPENDENCY_ROWS. */
  omitted: number;
  /** Manifests that were too large to parse. */
  skipped: string[];
};

export function emptyDependencyChanges(): DependencyChanges {
  return { packages: [], frameworks: [], sdks: [], images: [], omitted: 0, skipped: [] };
}

export function hasDependencyChanges(changes: DependencyChanges): boolean {
  return (
    changes.packages.length > 0 ||
    changes.frameworks.length > 0 ||
    changes.sdks.length > 0 ||
    changes.images.length > 0
  );
}

export function mergeDependencyChanges(a: DependencyChanges, b: DependencyChanges): DependencyChanges {
  return {
    packages: [...a.packages, ...b.packages],
    frameworks: [...a.frameworks, ...b.frameworks],
    sdks: [...a.sdks, ...b.sdks],
    images: [...a.images, ...b.images],
    omitted: a.omitted + b.omitted,
    skipped: [...a.skipped, ...b.skipped],
  };
}

export function capDependencyChanges(
  changes: DependencyChanges,
  max = MAX_DEPENDENCY_ROWS,
): DependencyChanges {
  const total =
    changes.packages.length + changes.frameworks.length + changes.sdks.length + changes.images.length;
  if (total <= max) return changes;
  let left = max;
  const take = <T>(rows: T[]): T[] => {
    const kept = rows.slice(0, Math.max(0, left));
    left -= kept.length;
    return kept;
  };
  const packages = take(changes.packages);
  const frameworks = take(changes.frameworks);
  const sdks = take(changes.sdks);
  const images = take(changes.images);
  return {
    packages,
    frameworks,
    sdks,
    images,
    omitted: changes.omitted + (total - max),
    skipped: changes.skipped,
  };
}

const PROJECT_FILE = /\.(cs|fs|vb)proj$/i;

export function basename(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] ?? p;
}

export function isDockerfile(p: string): boolean {
  const name = basename(p).toLowerCase();
  return name.startsWith("dockerfile") || name.endsWith(".dockerfile");
}

export function isPackageManifest(p: string): boolean {
  const name = basename(p).toLowerCase();
  if (!name) return false;
  if (PROJECT_FILE.test(name)) return true;
  if (isDockerfile(name)) return true;
  return (
    name === "directory.packages.props" ||
    name === "directory.build.props" ||
    name === "global.json" ||
    name === "packages.lock.json"
  );
}

function classify(from: string | undefined, to: string | undefined): ChangeKind | undefined {
  if (from === to) return undefined;
  if (from === undefined) return "added";
  if (to === undefined) return "removed";
  return "changed";
}

function versionFields(from?: string, to?: string): { from?: string; to?: string } {
  const fields: { from?: string; to?: string } = {};
  if (from !== undefined) fields.from = from;
  if (to !== undefined) fields.to = to;
  return fields;
}

const XML_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
};

function decodeXml(s: string): string {
  return s.replace(/&(?:amp|lt|gt|quot|apos);/g, (m) => XML_ENTITIES[m] ?? m);
}

function stripComments(xml: string): string {
  return xml.replace(/<!--[\s\S]*?-->/g, "");
}

function attrValue(attrs: string, name: string): string | undefined {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(attrs);
  const raw = m?.[1] ?? m?.[2];
  return raw === undefined ? undefined : decodeXml(raw).trim();
}

function childValue(inner: string, name: string): string | undefined {
  const m = new RegExp(`<${name}\\s*>([\\s\\S]*?)</${name}\\s*>`, "i").exec(inner);
  const raw = m?.[1];
  return raw === undefined ? undefined : decodeXml(raw).trim();
}

const PACKAGE_ELEMENT =
  /<(PackageReference|PackageVersion|GlobalPackageReference)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1\s*>)/gi;

/**
 * Package id -> version for `PackageReference` / `PackageVersion`, accepting `Include=` or
 * `Update=` and the version as an attribute or a child element. A reference with no version
 * (central package management) maps to the empty string, which is distinct from being absent.
 */
export function parsePackageVersions(xml: string): Map<string, string> {
  const versions = new Map<string, string>();
  for (const match of stripComments(xml).matchAll(PACKAGE_ELEMENT)) {
    const attrs = match[2] ?? "";
    const inner = match[3] ?? "";
    const id = attrValue(attrs, "Include") ?? attrValue(attrs, "Update");
    if (!id) continue;
    const version = attrValue(attrs, "Version") ?? childValue(inner, "Version") ?? "";
    const existing = versions.get(id);
    if (existing === undefined || (existing === "" && version !== "")) versions.set(id, version);
  }
  return versions;
}

const TFM_ELEMENT = /<(TargetFrameworks?)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi;

export function parseTargetFrameworks(xml: string): string[] {
  const frameworks: string[] = [];
  for (const match of stripComments(xml).matchAll(TFM_ELEMENT)) {
    for (const raw of decodeXml(match[2] ?? "").split(";")) {
      const tfm = raw.trim();
      if (tfm && !frameworks.includes(tfm)) frameworks.push(tfm);
    }
  }
  return frameworks;
}

export function parseSdkPin(json: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const sdk = (parsed as { sdk?: unknown }).sdk;
  if (typeof sdk !== "object" || sdk === null) return undefined;
  const version = (sdk as { version?: unknown }).version;
  return typeof version === "string" && version.trim() ? version.trim() : undefined;
}

function splitImageRef(ref: string): { name: string; tag: string } {
  const digest = ref.indexOf("@");
  if (digest > 0) return { name: ref.slice(0, digest), tag: ref.slice(digest + 1) };
  const colon = ref.lastIndexOf(":");
  const slash = ref.lastIndexOf("/");
  if (colon > slash && colon > 0) return { name: ref.slice(0, colon), tag: ref.slice(colon + 1) };
  return { name: ref, tag: "latest" };
}

/**
 * Base image name -> the tags it is pulled at, in file order. Multi-stage builds that pull the
 * same image twice collapse into one comma-joined entry so the diff stays one row per image.
 */
export function parseDockerImages(text: string): Map<string, string> {
  const stages = new Set<string>();
  const tags = new Map<string, string[]>();
  for (const line of text.split(/\r?\n/)) {
    const from = /^\s*FROM\s+(\S.*)$/i.exec(line);
    if (!from) continue;
    const words = (from[1] ?? "").trim().split(/\s+/).filter((w) => !w.startsWith("--"));
    const ref = words[0];
    if (!ref) continue;
    const asIndex = words.findIndex((w) => w.toLowerCase() === "as");
    const stage = asIndex >= 0 ? words[asIndex + 1] : undefined;
    if (stage) stages.add(stage.toLowerCase());
    if (stages.has(ref.toLowerCase())) continue;
    const { name, tag } = splitImageRef(ref);
    const seen = tags.get(name);
    if (seen) seen.push(tag);
    else tags.set(name, [tag]);
  }
  return new Map([...tags].map(([name, list]) => [name, list.join(", ")]));
}

function diffPackages(before: string, after: string, file: string): PackageChange[] {
  const beforeVersions = parsePackageVersions(before);
  const afterVersions = parsePackageVersions(after);
  const index = (versions: Map<string, string>): Map<string, string> =>
    new Map([...versions].map(([id, v]) => [id.toLowerCase(), v]));
  const beforeIndex = index(beforeVersions);
  const afterIndex = index(afterVersions);
  const display = new Map<string, string>();
  for (const id of beforeVersions.keys()) display.set(id.toLowerCase(), id);
  for (const id of afterVersions.keys()) display.set(id.toLowerCase(), id);

  const changes: PackageChange[] = [];
  for (const [key, id] of display) {
    const from = beforeIndex.get(key);
    const to = afterIndex.get(key);
    const kind = classify(from, to);
    if (!kind) continue;
    changes.push({ file, package: id, ...versionFields(from, to), kind });
  }
  return changes;
}

function diffFrameworks(before: string, after: string, file: string): FrameworkChange[] {
  const from = parseTargetFrameworks(before);
  const to = parseTargetFrameworks(after);
  const kind = classify(from.length ? from.join("; ") : undefined, to.length ? to.join("; ") : undefined);
  if (!kind) return [];
  return [
    {
      file,
      ...versionFields(from.length ? from.join("; ") : undefined, to.length ? to.join("; ") : undefined),
      kind,
    },
  ];
}

function diffImages(before: string, after: string, file: string): ImageChange[] {
  const beforeImages = parseDockerImages(before);
  const afterImages = parseDockerImages(after);
  const names = [...new Set([...beforeImages.keys(), ...afterImages.keys()])];
  const changes: ImageChange[] = [];
  for (const image of names) {
    const from = beforeImages.get(image);
    const to = afterImages.get(image);
    const kind = classify(from, to);
    if (!kind) continue;
    changes.push({ file, image, ...versionFields(from, to), kind });
  }
  return changes;
}

/** Compare the two sides of one changed manifest. Either side may be "" for add/delete. */
export function diffManifests(before: string, after: string, file: string): DependencyChanges {
  const changes = emptyDependencyChanges();
  if (before.length > MAX_MANIFEST_BYTES || after.length > MAX_MANIFEST_BYTES) {
    changes.skipped.push(file);
    return changes;
  }
  const name = basename(file).toLowerCase();
  if (name === "global.json") {
    const from = parseSdkPin(before);
    const to = parseSdkPin(after);
    const kind = classify(from, to);
    if (kind) changes.sdks.push({ file, ...versionFields(from, to), kind });
    return changes;
  }
  if (isDockerfile(name)) {
    changes.images.push(...diffImages(before, after, file));
    return changes;
  }
  if (name === "packages.lock.json") return changes;
  changes.packages.push(...diffPackages(before, after, file));
  changes.frameworks.push(...diffFrameworks(before, after, file));
  return changes;
}

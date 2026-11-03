/**
 * Nightly hygiene (docs/release.md, "Retencja nightly"): `bun scripts/prune-nightly.ts [--dry-run]`.
 *   1. GitHub releases: keeps the 10 newest complete nightly prereleases (with manifest.json); deletes older ones and
 *      incomplete ones (no manifest.json) that are past the grace period and have a newer complete nightly.
 *      Git tags stay: semantic-release needs prerelease counters and channel history.
 *   2. GHCR `canopy-{gateway,web,worker}`: deletes package versions tagged only with nightly versions that are no
 *      longer kept, then the untagged manifests (platforms, attestations) that only their OCI index referenced.
 * Anything newer than the grace period stays, as does any version carrying another tag or targeted by an alias.
 * Env: GH_TOKEN (or GITHUB_TOKEN), GITHUB_REPOSITORY; GITHUB_API_URL and CANOPY_REGISTRY_URL default to GitHub's.
 */

const NIGHTLY = /^v\d+\.\d+\.\d+-nightly\.\d+$/;
const KEEP_COMPLETE = 10;
export const GRACE_MS = 6 * 60 * 60 * 1000;
const APPS = ["gateway", "web", "worker"];
const ALIASES = ["nightly", "beta", "latest", "stable"];
const VERSION_ANNOTATION = "org.opencontainers.image.version";
const INDEX_TYPES = ["application/vnd.oci.image.index.v1+json", "application/vnd.docker.distribution.manifest.list.v2+json"];
const MANIFEST_TYPES = [...INDEX_TYPES, "application/vnd.oci.image.manifest.v1+json", "application/vnd.docker.distribution.manifest.v2+json"];

interface Release { id: number; tag_name: string; draft: boolean; prerelease: boolean; created_at: string; published_at: string | null; assets: { name: string }[] }
interface PackageVersion { id: number; name: string; created_at: string; updated_at: string; metadata?: { container?: { tags?: string[] } } }
interface Manifest { mediaType?: string; manifests?: { digest: string }[]; annotations?: Record<string, string> }

export interface HygieneOptions {
  apiUrl: string;
  registryUrl: string;
  token: string;
  repository: string;
  dryRun: boolean;
  now?: number;
  log?: (line: string) => void;
}
export interface HygieneResult {
  deletedReleases: string[];
  /** `canopy-<app>` → deleted versions as `<id> <digest> [tags]`. */
  deletedVersions: Record<string, string[]>;
  errors: string[];
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/** Semver order of nightly tags. */
function compareNightly(a: string, b: string): number {
  const [pa, pb] = [a.match(/\d+/g)!.map(Number), b.match(/\d+/g)!.map(Number)];
  for (let i = 0; i < 4; i++) if (pa[i] !== pb[i]) return pa[i]! - pb[i]!;
  return 0;
}

function tagsOf(version: PackageVersion): string[] {
  return version.metadata?.container?.tags ?? [];
}

export async function runHygiene(options: HygieneOptions): Promise<HygieneResult> {
  const now = options.now ?? Date.now();
  const log = options.log ?? console.info;
  const mark = options.dryRun ? "[dry run] would delete" : "deleted";
  const [owner] = options.repository.split("/");
  const result: HygieneResult = { deletedReleases: [], deletedVersions: {}, errors: [] };
  const old = (...dates: (string | null | undefined)[]) => dates.every((date) => !date || now - Date.parse(date) >= GRACE_MS);

  async function call(url: string, init: RequestInit = {}): Promise<Response> {
    const response = await fetch(url, { ...init, headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", Authorization: `Bearer ${options.token}`, ...init.headers } });
    if (!response.ok) {
      const message = await response.json().then((body) => (body as { message?: string }).message ?? "", () => "");
      throw new HttpError(response.status, `${init.method ?? "GET"} ${new URL(url).pathname} → HTTP ${response.status}${message ? ` ${message}` : ""}`);
    }
    return response;
  }
  async function pages<T>(path: string): Promise<T[]> {
    const items: T[] = [];
    let url: string | undefined = `${options.apiUrl}/${path}`;
    while (url) {
      const response = await call(url);
      items.push(...await response.json() as T[]);
      url = response.headers.get("link")?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
    }
    return items;
  }
  async function remove(path: string): Promise<void> {
    if (!options.dryRun) await call(`${options.apiUrl}/${path}`, { method: "DELETE" });
  }

  // 1. GitHub releases.
  const nightlies = (await pages<Release>(`repos/${options.repository}/releases?per_page=100`))
    .filter((release) => !release.draft && release.prerelease && NIGHTLY.test(release.tag_name))
    .sort((a, b) => compareNightly(b.tag_name, a.tag_name));
  const complete = nightlies.filter((release) => release.assets.some((asset) => asset.name === "manifest.json"));
  const newestComplete = complete[0]?.tag_name;
  const pruned = new Set([
    ...complete.slice(KEEP_COMPLETE),
    // Incomplete: a failed or cancelled publication; "Re-run failed jobs" can finish it within the grace period.
    ...nightlies.filter((release) => !complete.includes(release) && newestComplete && compareNightly(release.tag_name, newestComplete) < 0
      && old(release.created_at, release.published_at)),
  ]);
  const kept = new Set(nightlies.filter((release) => !pruned.has(release)).map((release) => release.tag_name));
  for (const release of nightlies) {
    if (!pruned.has(release)) continue;
    await remove(`repos/${options.repository}/releases/${release.id}`);
    result.deletedReleases.push(release.tag_name);
    log(`${mark} nightly release ${release.tag_name}${complete.includes(release) ? "" : " (incomplete, no manifest.json)"}; git tag retained`);
  }
  log(`kept nightly releases: ${[...kept].join(", ") || "none"}`);

  // 2. GHCR package versions.
  if (!newestComplete) {
    log("no complete nightly release: GHCR left alone");
    return result;
  }
  for (const app of APPS) {
    const name = `canopy-${app}`;
    try {
      result.deletedVersions[name] = await prunePackage(name);
    } catch (error) {
      const message = error instanceof HttpError && [401, 403, 404].includes(error.status)
        ? `GHCR ${name}: no access to package versions (${error.message}). Give this repository the Admin role in the package settings (Manage Actions access) and keep packages: write on the hygiene job; see docs/release.md, "Retencja nightly".`
        : `GHCR ${name}: ${error instanceof Error ? error.message : String(error)}`;
      result.errors.push(message);
      console.error(message);
    }
  }
  return result;

  async function prunePackage(name: string): Promise<string[]> {
    const base = `orgs/${owner}/packages/container/${name}/versions`;
    const versions = await pages<PackageVersion>(`${base}?per_page=100&state=active`);
    const registry = await registryClient(name);
    const manifests = new Map<string, Manifest | null>();
    const manifest = async (digest: string) => {
      if (!manifests.has(digest)) manifests.set(digest, await registry(digest));
      return manifests.get(digest)!;
    };
    const children = async (digest: string, into = new Set<string>()): Promise<Set<string>> => {
      for (const child of (await manifest(digest))?.manifests ?? []) {
        if (into.has(child.digest)) continue;
        into.add(child.digest);
        await children(child.digest, into);
      }
      return into;
    };

    // Versions the channel aliases point at (by digest, then by the version their index is annotated with).
    const protectedTags = new Set<string>();
    for (const version of versions.filter((version) => tagsOf(version).some((tag) => ALIASES.includes(tag)))) {
      const annotated = (await manifest(version.name))?.annotations?.[VERSION_ANNOTATION];
      if (annotated) protectedTags.add(`v${annotated}`);
    }
    const doomed = versions.filter((version) => {
      const tags = tagsOf(version);
      return tags.length > 0 && tags.every((tag) => NIGHTLY.test(tag) && !kept.has(tag) && !protectedTags.has(tag) && compareNightly(tag, newestComplete!) < 0)
        && old(version.created_at, version.updated_at);
    });
    const doomedIds = new Set(doomed.map((version) => version.id));

    // Untagged manifests go only if no surviving index (tagged or not) references them.
    const referenced = new Set<string>();
    for (const version of versions) if (!doomedIds.has(version.id)) for (const digest of await children(version.name)) referenced.add(digest);
    const byDigest = new Map(versions.map((version) => [version.name, version]));
    const deleted: string[] = [];
    const drop = async (version: PackageVersion) => {
      await remove(`${base}/${version.id}`);
      const label = `${version.id} ${version.name} [${tagsOf(version).join(", ")}]`;
      deleted.push(label);
      log(`${mark} ${name} version ${label}`);
    };
    for (const index of doomed) {
      // Children first: if the run stops halfway, the still tagged index finds them again next time.
      for (const digest of await children(index.name)) {
        const child = byDigest.get(digest);
        if (!child || tagsOf(child).length > 0 || referenced.has(digest) || doomedIds.has(child.id) || !old(child.created_at, child.updated_at)) continue;
        doomedIds.add(child.id);
        await drop(child);
      }
      await drop(index);
    }
    const keptTags = versions.filter((version) => !doomedIds.has(version.id)).flatMap(tagsOf).filter((tag) => NIGHTLY.test(tag));
    log(`${name}: kept nightly tags ${keptTags.sort(compareNightly).join(", ") || "none"}; ${versions.length - doomedIds.size} of ${versions.length} versions kept`);
    return deleted;
  }

  /** Manifest fetcher for `<owner>/<name>` on the registry, with a pull token from its token endpoint. */
  async function registryClient(name: string): Promise<(digest: string) => Promise<Manifest | null>> {
    const repo = `${owner}/${name}`.toLowerCase();
    const auth = await call(`${options.registryUrl}/token?service=${new URL(options.registryUrl).host}&scope=repository:${repo}:pull`, {
      headers: { Authorization: `Basic ${btoa(`token:${options.token}`)}`, Accept: "application/json" },
    });
    const { token } = await auth.json() as { token: string };
    return async (digest) => {
      const response = await fetch(`${options.registryUrl}/v2/${repo}/manifests/${digest}`, { headers: { Authorization: `Bearer ${token}`, Accept: MANIFEST_TYPES.join(", ") } });
      if (response.status === 404) return null;
      if (!response.ok) throw new HttpError(response.status, `GET manifest ${digest} → HTTP ${response.status}`);
      const body = await response.json() as Manifest;
      const type = body.mediaType ?? response.headers.get("content-type") ?? "";
      return INDEX_TYPES.some((index) => type.startsWith(index)) ? body : { ...body, manifests: [] };
    };
  }
}

if (import.meta.main) {
  const token = process.env["GH_TOKEN"] || process.env["GITHUB_TOKEN"];
  const repository = process.env["GITHUB_REPOSITORY"];
  if (!token || !repository || !/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error("GH_TOKEN and GITHUB_REPOSITORY are required");
  const result = await runHygiene({
    apiUrl: process.env["GITHUB_API_URL"] || "https://api.github.com",
    registryUrl: process.env["CANOPY_REGISTRY_URL"] || "https://ghcr.io",
    token, repository, dryRun: process.argv.includes("--dry-run"),
  });
  if (result.errors.length) {
    console.error(`Nightly hygiene: releases pruned, GHCR incomplete (${result.errors.length} package${result.errors.length === 1 ? "" : "s"} failed)`);
    process.exit(1);
  }
}

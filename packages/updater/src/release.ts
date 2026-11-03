export type InstallKind = "binary" | "docker" | "source";
export interface ReleaseAsset {
  app: "gateway" | "worker" | "desktop";
  os: "linux" | "darwin" | "windows";
  arch: "x64" | "arm64";
  name: string;
  url: string;
  sha256: string;
  size: number;
}
export interface ReleaseManifest {
  schema: 1;
  version: string;
  channel: string;
  commit: string;
  published_at: string;
  protocol: { worker_link: number; update: number };
  assets: ReleaseAsset[];
}
export interface ReleaseSourceOptions {
  /** GitHub API repository URL, or explicit mirror/test endpoint with the same layout. */
  baseUrl?: string;
  /** Deliberate test-only escape hatch; production callers never set this from the environment. */
  allowHttpForTests?: boolean;
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
}
class ReleaseHttpError extends Error {
  constructor(readonly status: number) { super(`Release server returned HTTP ${status}`); }
}
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/;
export function validChannel(channel: string): boolean {
  return channel === "latest" || /^v(0|[1-9]\d*)(?:\.(0|[1-9]\d*)){0,2}$/.test(channel);
}
export function compareVersions(a: string, b: string): number {
  const left = SEMVER.exec(a), right = SEMVER.exec(b);
  if (!left || !right) throw new Error("Invalid semver version");
  for (let i = 1; i <= 3; i++) { const diff = Number(left[i]) - Number(right[i]); if (diff) return Math.sign(diff); }
  if (!left[4] && !right[4]) return 0;
  if (!left[4]) return 1;
  if (!right[4]) return -1;
  const l = left[4].split("."), r = right[4].split(".");
  for (let i = 0; i < Math.max(l.length, r.length); i++) {
    if (l[i] === undefined) return -1;
    if (r[i] === undefined) return 1;
    if (l[i] === r[i]) continue;
    const ln = /^\d+$/.test(l[i]!), rn = /^\d+$/.test(r[i]!);
    if (ln && rn) return Math.sign(Number(l[i]) - Number(r[i]));
    if (ln !== rn) return ln ? -1 : 1;
    return l[i]! < r[i]! ? -1 : 1;
  }
  return 0;
}

export function secureUrl(value: string, allowHttpForTests = false): URL {
  const url = new URL(value);
  if ((url.protocol !== "https:" && !(allowHttpForTests && url.protocol === "http:")) || url.username || url.password || url.hash) {
    throw new Error("Release downloads require HTTPS without embedded credentials");
  }
  return url;
}

/** Manual redirect handling prevents HTTPS -> HTTP redirects from bypassing validation. */
export async function releaseFetch(url: string, options: ReleaseSourceOptions = {}): Promise<Response> {
  let target = secureUrl(url, options.allowHttpForTests);
  for (let i = 0; i < 6; i++) {
    const response = await (options.fetch ?? fetch)(target, { redirect: "manual", signal: AbortSignal.timeout(120_000), headers: { accept: "application/json", "user-agent": "Canopy-Updater" } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) throw new Error("Release redirect has no location");
      target = secureUrl(new URL(location, target).href, options.allowHttpForTests);
      continue;
    }
    if (!response.ok) { await response.body?.cancel(); throw new ReleaseHttpError(response.status); }
    return response;
  }
  throw new Error("Too many release redirects");
}

export function parseManifest(value: unknown, options: ReleaseSourceOptions = {}): ReleaseManifest {
  if (!value || typeof value !== "object") throw new Error("Invalid release manifest");
  const m = value as ReleaseManifest;
  if (m.schema !== 1 || !SEMVER.test(m.version) || !validChannel(m.channel) || typeof m.commit !== "string" || typeof m.published_at !== "string" ||
      !m.protocol || !Number.isInteger(m.protocol.worker_link) || m.protocol.worker_link < 1 || !Number.isInteger(m.protocol.update) || m.protocol.update < 1 || !Array.isArray(m.assets)) throw new Error("Invalid release manifest schema");
  const names = new Set<string>();
  for (const a of m.assets) {
    if (!a || !["gateway", "worker", "desktop"].includes(a.app) || !["linux", "darwin", "windows"].includes(a.os) || !["x64", "arm64"].includes(a.arch) ||
        typeof a.name !== "string" || (a.app === "desktop" ? !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(a.name) : a.name !== `canopy-${a.app}-${a.os}-${a.arch}${a.os === "windows" ? ".exe" : ""}`) || names.has(a.name) ||
        !/^[a-f0-9]{64}$/i.test(a.sha256) || !Number.isSafeInteger(a.size) || a.size < 1 || a.size > 2 * 1024 ** 3) throw new Error("Invalid release asset");
    secureUrl(a.url, options.allowHttpForTests);
    names.add(a.name);
  }
  return m;
}

interface GithubRelease { tag_name: string; draft: boolean; prerelease: boolean; assets: { name: string; browser_download_url: string }[] }
export class ReleaseSource {
  readonly options: ReleaseSourceOptions;
  readonly baseUrl: string;
  constructor(options: ReleaseSourceOptions = {}) {
    this.options = options;
    this.baseUrl = secureUrl(options.baseUrl ?? "https://api.github.com/repos/itsoltech/canopy", options.allowHttpForTests).href.replace(/\/$/, "");
  }
  async resolve(channel: string): Promise<ReleaseManifest> {
    if (!validChannel(channel)) throw new Error("Use latest, vX, vX.Y or vX.Y.Z");
    let release: GithubRelease | undefined;
    if (channel === "latest" || /^v\d+\.\d+\.\d+$/.test(channel)) {
      try {
        release = await (await releaseFetch(`${this.baseUrl}/releases/tags/${channel}`, this.options)).json() as GithubRelease;
      } catch (error) {
        // Mirrors may retain stable X.Y.Z tags; the pipeline publishes vX.Y.Z.
        if (channel === "latest" || !(error instanceof ReleaseHttpError) || error.status !== 404) throw error;
        release = await (await releaseFetch(`${this.baseUrl}/releases/tags/${channel.slice(1)}`, this.options)).json() as GithubRelease;
      }
    } else {
      const candidates: GithubRelease[] = [];
      for (let page = 1; ; page++) {
        const batch = await (await releaseFetch(`${this.baseUrl}/releases?per_page=100&page=${page}`, this.options)).json() as GithubRelease[];
        if (!Array.isArray(batch)) throw new Error("Invalid releases response");
        candidates.push(...batch.filter((r) => !r.draft && !r.prerelease && SEMVER.test(r.tag_name.replace(/^v/, "")) && !r.tag_name.includes("-") && r.tag_name.replace(/^v/, "").startsWith(`${channel.slice(1)}.`)));
        if (batch.length < 100) break;
        if (page >= 100) throw new Error("Release list exceeds pagination limit");
      }
      release = candidates.sort((a, b) => compareVersions(b.tag_name.replace(/^v/, ""), a.tag_name.replace(/^v/, "")))[0];
    }
    if (!release || release.draft || (channel !== "latest" && release.prerelease)) throw new Error("No release for this channel");
    const asset = release.assets?.find((a) => a.name === "manifest.json");
    if (!asset) throw new Error("Release has no manifest.json");
    const response = await releaseFetch(asset.browser_download_url, this.options);
    const json = await response.text();
    if (json.length > 2 * 1024 * 1024) throw new Error("Release manifest is too large");
    const manifest = parseManifest(JSON.parse(json), this.options);
    if (channel !== "latest" && manifest.version !== release.tag_name.replace(/^v/, "")) throw new Error("Release tag and manifest version differ");
    return manifest;
  }
  async version(version: string): Promise<ReleaseManifest> {
    if (!SEMVER.test(version)) throw new Error("Invalid release version");
    const manifest = await this.resolve(version.includes("-") ? "latest" : `v${version}`);
    if (manifest.version !== version) throw new Error("This gateway version is no longer published; use a retained release or cached manifest");
    return manifest;
  }
}
export function releaseAsset(manifest: ReleaseManifest, app: ReleaseAsset["app"], os: string, arch: string): ReleaseAsset {
  const asset = manifest.assets.find((a) => a.app === app && a.os === os && a.arch === arch);
  if (!asset) throw new Error(`No ${app} binary for ${os}/${arch}`);
  return asset;
}

import { isJsonArray, isJsonObject, type JsonObject, type JsonValue } from "@canopy/domain/json";

export type InstallKind = "binary" | "docker" | "source" | "desktop";

export type ReleaseAsset = {
  app: "gateway" | "worker" | "desktop";
  os: "linux" | "darwin" | "windows";
  arch: "x64" | "arm64";
  name: string;
  url: string;
  sha256: string;
  size: number;
};

export type ReleaseManifest = {
  schema: 1;
  version: string;
  channel: string;
  commit: string;
  published_at: string;
  protocol: { worker_link: number; update: number };
  assets: ReleaseAsset[];
};

export interface ReleaseSourceOptions {
  /** GitHub API repository URL, or explicit mirror/test endpoint with the same layout. */
  baseUrl?: string;
  /** Deliberate test-only escape hatch; production callers never set this from the environment. */
  allowHttpForTests?: boolean;
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
}

class ReleaseHttpError extends Error {
  constructor(readonly status: number) {
    super(`Release server returned HTTP ${status}`);
  }
}

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/;

/** Legacy clients/settings may still send latest; it now always means stable. */
export function normalizeChannel(channel: string): string {
  return channel === "latest" ? "stable" : channel;
}

export function validChannel(channel: string): boolean {
  return (
    ["stable", "beta", "nightly"].includes(normalizeChannel(channel)) ||
    /^v(0|[1-9]\d*)(?:\.(0|[1-9]\d*)){0,2}$/.test(channel)
  );
}

export function compareVersions(a: string, b: string): number {
  const left = SEMVER.exec(a),
    right = SEMVER.exec(b);

  if (!left || !right) throw new Error("Invalid semver version");

  for (let i = 1; i <= 3; i++) {
    const diff = Number(left[i]) - Number(right[i]);

    if (diff) return Math.sign(diff);
  }

  if (!left[4] && !right[4]) return 0;

  if (!left[4]) return 1;

  if (!right[4]) return -1;

  const l = left[4].split("."),
    r = right[4].split(".");

  for (let i = 0; i < Math.max(l.length, r.length); i++) {
    if (l[i] === undefined) return -1;

    if (r[i] === undefined) return 1;

    if (l[i] === r[i]) continue;

    const ln = /^\d+$/.test(l[i]!),
      rn = /^\d+$/.test(r[i]!);

    if (ln && rn) return Math.sign(Number(l[i]) - Number(r[i]));

    if (ln !== rn) return ln ? -1 : 1;

    return l[i]! < r[i]! ? -1 : 1;
  }

  return 0;
}

export function secureUrl(value: string, allowHttpForTests = false): URL {
  const url = new URL(value);

  if (
    (url.protocol !== "https:" && !(allowHttpForTests && url.protocol === "http:")) ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new Error("Release downloads require HTTPS without embedded credentials");
  }

  return url;
}

/** Manual redirect handling prevents HTTPS -> HTTP redirects from bypassing validation. */
export async function releaseFetch(url: string, options: ReleaseSourceOptions = {}): Promise<Response> {
  let target = secureUrl(url, options.allowHttpForTests);

  for (let i = 0; i < 6; i++) {
    const response = await (options.fetch ?? fetch)(target, {
      redirect: "manual",
      signal: AbortSignal.timeout(120_000),
      headers: { accept: "application/json", "user-agent": "Canopy-Updater" },
    });

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel();

      if (!location) throw new Error("Release redirect has no location");
      target = secureUrl(new URL(location, target).href, options.allowHttpForTests);
      continue;
    }

    if (!response.ok) {
      await response.body?.cancel();
      throw new ReleaseHttpError(response.status);
    }

    return response;
  }

  throw new Error("Too many release redirects");
}

export function parseManifest(value: JsonValue, options: ReleaseSourceOptions = {}): ReleaseManifest {
  if (!value || (!isJsonObject(value) && !isJsonArray(value))) throw new Error("Invalid release manifest");

  if (!isJsonObject(value) || !isManifestFields(value)) throw new Error("Invalid release manifest schema");
  const names = new Set<string>();
  const assets: ReleaseAsset[] = [];

  for (const a of value.assets) {
    if (!isReleaseAsset(a) || names.has(a.name)) throw new Error("Invalid release asset");
    secureUrl(a.url, options.allowHttpForTests);
    names.add(a.name);
    assets.push(a);
  }

  return { ...value, assets };
}

type ManifestFields = JsonObject & Omit<ReleaseManifest, "assets"> & { readonly assets: readonly JsonValue[] };

function isManifestFields(m: JsonObject): m is ManifestFields {
  const protocol = m["protocol"];

  return (
    m["schema"] === 1 &&
    isText(m["version"]) &&
    SEMVER.test(m["version"]) &&
    isText(m["channel"]) &&
    validChannel(m["channel"]) &&
    isText(m["commit"]) &&
    isText(m["published_at"]) &&
    isJsonObject(protocol) &&
    isPositiveInteger(protocol["worker_link"]) &&
    isPositiveInteger(protocol["update"]) &&
    isJsonArray(m["assets"])
  );
}

function isReleaseAsset(a: JsonValue): a is JsonObject & ReleaseAsset {
  if (!isJsonObject(a)) return false;
  const { app, os, arch, name, url, sha256, size } = a;

  return (
    (app === "gateway" || app === "worker" || app === "desktop") &&
    (os === "linux" || os === "darwin" || os === "windows") &&
    (arch === "x64" || arch === "arm64") &&
    isText(name) &&
    (app === "desktop"
      ? /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)
      : name === `canopy-${app}-${os}-${arch}${os === "windows" ? ".exe" : ""}`) &&
    isText(url) &&
    isText(sha256) &&
    /^[a-f0-9]{64}$/i.test(sha256) &&
    typeof size === "number" &&
    Number.isSafeInteger(size) &&
    size >= 1 &&
    size <= 2 * 1024 ** 3
  );
}

type GithubRelease = {
  tag_name: string;
  draft?: boolean;
  prerelease?: boolean;
  assets?: { name: string; browser_download_url: string }[];
};

function isGithubRelease(release: JsonValue): release is JsonObject & GithubRelease {
  if (!isJsonObject(release)) return false;
  const assets = release["assets"];

  return (
    isText(release["tag_name"]) &&
    isOptionalFlag(release["draft"]) &&
    isOptionalFlag(release["prerelease"]) &&
    (assets === undefined ||
      (isJsonArray(assets) &&
        assets.every((asset) => isJsonObject(asset) && isText(asset["name"]) && isText(asset["browser_download_url"]))))
  );
}

/** GitHub's release JSON, checked for the fields the channel resolution reads. */
async function githubRelease(response: Response): Promise<GithubRelease> {
  const release = await jsonBody(response);

  if (!isGithubRelease(release)) throw new Error("Invalid release response");

  return release;
}

async function jsonBody(response: Response): Promise<JsonValue> {
  return JSON.parse(await response.text());
}

function isText(value: JsonValue | undefined): value is string {
  return typeof value === "string";
}

function isOptionalFlag(value: JsonValue | undefined): value is boolean | undefined {
  return value === undefined || typeof value === "boolean";
}

function isPositiveInteger(value: JsonValue | undefined): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

export class ReleaseSource {
  readonly options: ReleaseSourceOptions;
  readonly baseUrl: string;
  constructor(options: ReleaseSourceOptions = {}) {
    this.options = options;
    this.baseUrl = secureUrl(
      options.baseUrl ?? "https://api.github.com/repos/itsoltech/canopy",
      options.allowHttpForTests,
    ).href.replace(/\/$/, "");
  }
  async resolve(channel: string, accept?: (manifest: ReleaseManifest) => boolean): Promise<ReleaseManifest> {
    channel = normalizeChannel(channel);

    if (!validChannel(channel)) throw new Error("Use stable, beta, nightly, vX, vX.Y or vX.Y.Z");

    if (/^v\d+\.\d+\.\d+$/.test(channel)) {
      const manifest = await this.#exact(channel.slice(1), true);

      if (accept && !accept(manifest)) throw new Error("No compatible release for this channel");

      return manifest;
    }

    const candidates: GithubRelease[] = [];

    for (let page = 1; ; page++) {
      const batch = await jsonBody(
        await releaseFetch(`${this.baseUrl}/releases?per_page=100&page=${page}`, this.options),
      );

      if (!isJsonArray(batch) || !batch.every(isGithubRelease)) throw new Error("Invalid releases response");
      candidates.push(
        ...batch.filter((release) => {
          const version = release.tag_name.replace(/^v/, "");
          const match = SEMVER.exec(version);

          // Drafts are staged before publication; older incomplete releases may also lack manifest.json.
          if (!match || release.draft || !release.assets?.some((asset) => asset.name === "manifest.json")) return false;
          const stable = !release.prerelease && !match[4];

          if (channel === "nightly") return true;

          if (channel === "beta") return stable || (release.prerelease && /^beta\.\d+$/.test(match[4] ?? ""));

          return stable && (channel === "stable" || version.startsWith(`${channel.slice(1)}.`));
        }),
      );

      if (batch.length < 100) break;

      if (page >= 100) throw new Error("Release list exceeds pagination limit");
    }

    candidates.sort((a, b) => compareVersions(b.tag_name.replace(/^v/, ""), a.tag_name.replace(/^v/, "")));

    for (const release of candidates) {
      const manifest = await this.#manifest(release);

      if (!accept || accept(manifest)) return manifest;
    }

    throw new Error(accept ? "No compatible release for this channel" : "No release for this channel");
  }
  async #exact(version: string, stableOnly: boolean): Promise<ReleaseManifest> {
    let release: GithubRelease;

    try {
      release = await githubRelease(await releaseFetch(`${this.baseUrl}/releases/tags/v${version}`, this.options));
    } catch (error) {
      if (!(error instanceof ReleaseHttpError) || error.status !== 404) throw error;
      release = await githubRelease(await releaseFetch(`${this.baseUrl}/releases/tags/${version}`, this.options));
    }

    if (release.draft || (stableOnly && release.prerelease)) throw new Error("No release for this channel");

    if (release.tag_name.replace(/^v/, "") !== version) throw new Error("Requested version and release tag differ");

    return this.#manifest(release);
  }
  async #manifest(release: GithubRelease): Promise<ReleaseManifest> {
    const asset = release.assets?.find((a) => a.name === "manifest.json");

    if (!asset) throw new Error("Release has no manifest.json");
    const response = await releaseFetch(asset.browser_download_url, this.options);
    const json = await response.text();

    if (json.length > 2 * 1024 * 1024) throw new Error("Release manifest is too large");
    const manifest = parseManifest(JSON.parse(json), this.options);

    if (manifest.version !== release.tag_name.replace(/^v/, ""))
      throw new Error("Release tag and manifest version differ");

    return manifest;
  }
  async version(version: string): Promise<ReleaseManifest> {
    if (!SEMVER.test(version)) throw new Error("Invalid release version");

    // Fetch our immutable prerelease, even when a newer nightly has been published.
    return this.#exact(version, false);
  }
}

export function releaseAsset(
  manifest: ReleaseManifest,
  app: ReleaseAsset["app"],
  os: string,
  arch: string,
): ReleaseAsset {
  const asset = manifest.assets.find((a) => a.app === app && a.os === os && a.arch === arch);

  if (!asset) throw new Error(`No ${app} binary for ${os}/${arch}`);

  return asset;
}

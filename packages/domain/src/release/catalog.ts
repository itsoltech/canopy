import { Schema } from "effect";
import { ReleaseHttp, releaseHttp, secureReleaseUrl, RELEASE_CACHE_MS } from "./http.ts";

export const RELEASE_INDEX_URL = "https://itsoltech.github.io/canopy/releases/v1.json";
export const RELEASE_API_URL = "https://api.github.com/repos/itsoltech/canopy";

const Asset = Schema.Struct({ name: Schema.String, browser_download_url: Schema.String });

const ApiRelease = Schema.Struct({
  tag_name: Schema.String,
  draft: Schema.optionalKey(Schema.Boolean),
  prerelease: Schema.optionalKey(Schema.Boolean),
  published_at: Schema.optionalKey(Schema.NullOr(Schema.String)),
  body: Schema.optionalKey(Schema.NullOr(Schema.String)),
  assets: Schema.optionalKey(Schema.Array(Asset)),
});

const IndexRelease = Schema.Struct({
  tag_name: Schema.String,
  draft: Schema.Literal(false),
  prerelease: Schema.Boolean,
  published_at: Schema.String,
  body: Schema.NullOr(Schema.String),
  assets: Schema.Array(Asset),
});

const Index = Schema.Struct({ schema: Schema.Literal(1), releases: Schema.Array(IndexRelease) });

export type CatalogRelease = Omit<Schema.Schema.Type<typeof IndexRelease>, "draft"> & { readonly draft: boolean };

export function parseReleaseIndex(text: string): readonly CatalogRelease[] {
  const index = Schema.decodeUnknownSync(Index)(JSON.parse(text));
  const tags = new Set<string>();

  for (const release of index.releases) {
    if (
      !Number.isFinite(Date.parse(release.published_at)) ||
      tags.has(release.tag_name) ||
      !release.assets.some((asset) => asset.name === "manifest.json")
    )
      throw new Error("Invalid release index");
    tags.add(release.tag_name);

    for (const asset of release.assets) secureReleaseUrl(asset.browser_download_url);
  }

  return index.releases;
}

export function parseApiRelease(value: Schema.Schema.Type<typeof ApiRelease>): CatalogRelease {
  return {
    ...value,
    draft: value.draft ?? false,
    prerelease: value.prerelease ?? false,
    published_at: value.published_at ?? "",
    body: value.body ?? null,
    assets: value.assets ?? [],
  };
}

export interface ReleaseCatalogOptions {
  http?: ReleaseHttp;
  baseUrl?: string | undefined;
  /** Custom mirrors use their API layout unless an index URL is explicitly supplied. */
  indexUrl?: string | false | undefined;
  now?: (() => number) | undefined;
}

/** Discovery is advisory. Installers still verify manifests, hashes and platform signatures. */
export class ReleaseCatalog {
  readonly http: ReleaseHttp;
  readonly baseUrl: string;
  private readonly indexUrl: string | false;
  private unavailableUntil = 0;
  constructor(readonly options: ReleaseCatalogOptions = {}) {
    this.http = options.http ?? releaseHttp;
    this.baseUrl = options.baseUrl ?? RELEASE_API_URL;
    this.indexUrl = options.indexUrl ?? (options.baseUrl ? false : RELEASE_INDEX_URL);
  }

  private async index(): Promise<readonly CatalogRelease[] | undefined> {
    if (!this.indexUrl || (this.options.now ?? Date.now)() < this.unavailableUntil) return undefined;

    try {
      return parseReleaseIndex(await this.http.text(this.indexUrl));
    } catch {
      this.unavailableUntil = (this.options.now ?? Date.now)() + RELEASE_CACHE_MS;

      return undefined;
    }
  }

  async releases(): Promise<readonly CatalogRelease[]> {
    const index = await this.index();

    if (index) return index;
    const all: CatalogRelease[] = [];

    for (let page = 1; page <= 100; page++) {
      const text = await this.http.text(`${this.baseUrl}/releases?per_page=100&page=${page}`);
      const batch = Schema.decodeUnknownSync(Schema.Array(ApiRelease))(JSON.parse(text));
      all.push(...batch.map(parseApiRelease));

      if (batch.length < 100) return all;
    }

    throw new Error("Release list exceeds pagination limit");
  }

  async tag(tag: string): Promise<CatalogRelease> {
    const index = await this.index();

    if (index) {
      const release = index.find((item) => item.tag_name.replace(/^v/, "") === tag.replace(/^v/, ""));

      if (!release) throw new Error("No release for this channel");

      return release;
    }

    const text = await this.http.text(`${this.baseUrl}/releases/tags/${encodeURIComponent(tag)}`);

    return parseApiRelease(Schema.decodeUnknownSync(ApiRelease)(JSON.parse(text)));
  }
}

export const releaseCatalog = new ReleaseCatalog();

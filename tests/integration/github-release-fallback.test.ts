import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { dockerAvailable } from "@canopy/db/testing";
import { ReleaseCatalog, RELEASE_INDEX_URL } from "@canopy/domain/release/catalog";
import { ReleaseHttp, ReleaseRateLimit } from "@canopy/domain/release/http";
import { githubReleaseFetch } from "../../apps/gateway/src/github/release-fetch.ts";
import { connectGitHub } from "./support/github-pr.ts";
import { readFixture } from "./support/github-read.ts";
import { startTestGateway, type TestGateway } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("authenticated release lookup after the static index", () => {
  const fixture = readFixture();
  let gw: TestGateway;
  let account = "";
  let index = true;
  let limited = false;
  let publicApi = 0;
  let publicCredentials = false;
  const api = "https://api.github.com/repos/itsoltech/canopy/releases?per_page=100&page=1";

  const publicFetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const headers = new Headers(init?.headers);
    publicCredentials ||= headers.has("authorization") || headers.has("cookie");

    if (url.href === RELEASE_INDEX_URL)
      return index ? Response.json({ schema: 1, releases: [] }) : new Response(null, { status: 503 });
    publicApi++;

    return limited
      ? new Response(null, { status: 429, headers: { "retry-after": "60" } })
      : Response.json([{ tag_name: "v1.0.0", draft: false, prerelease: false }]);
  };

  const releaseHttp = () => {
    const wrapped = githubReleaseFetch(gw.core.github, async () => true, publicFetch);

    return new ReleaseHttp({ fetch: wrapped, cacheScope: wrapped.cacheScope });
  };

  beforeAll(async () => {
    gw = await startTestGateway({ github: fixture.options });
  }, 60_000);
  afterAll(async () => {
    await gw?.close();
    fixture.close();
  });

  test("uses the CDN's empty result without a second lookup, including when there is no account", async () => {
    const catalog = new ReleaseCatalog({ http: releaseHttp() });
    expect(await catalog.releases()).toHaveLength(0);
    expect(publicApi).toBe(0);
    expect(fixture.counts.get("/repos/itsoltech/canopy/releases") ?? 0).toBe(0);
  });

  test("public cooldown does not block a newly connected account; default-on, off and restart preserve choice", async () => {
    index = false;
    limited = true;
    const http = releaseHttp();
    const catalog = new ReleaseCatalog({ http });
    expect(await catalog.releases().catch((e) => e)).toBeInstanceOf(ReleaseRateLimit);
    account = await connectGitHub(gw, fixture);
    expect((await gw.api.getGitHubUpdateAccount({})).enabled).toBe(true);
    expect((await catalog.releases())[0]?.tag_name).toBe("v1.0.0");
    expect(fixture.counts.get("/repos/itsoltech/canopy/releases")).toBe(1);
    await gw.api.setGitHubUpdateAccount({ accountId: account, enabled: false });
    limited = false;
    expect(await releaseHttp().text(api)).toContain("v1.0.0");
    expect(fixture.counts.get("/repos/itsoltech/canopy/releases")).toBe(1);
    expect(publicCredentials).toBe(false);
    await gw.api.setGitHubUpdateAccount({ accountId: account, enabled: true });
  });

  test("never sends a token to CDN/assets/redirects or uses a non-admin owner's account", async () => {
    const before = fixture.counts.get("/repos/itsoltech/canopy/releases") ?? 0;
    const wrapped = githubReleaseFetch(gw.core.github, async () => true, publicFetch);
    await wrapped.cacheScope(api);
    await wrapped(api, { headers: { authorization: "fixture-caller-value", cookie: "fixture-cookie" } }, true);
    await wrapped("https://cdn.example.test/manifest.json", { headers: { authorization: "fixture-caller-value" } });
    expect(fixture.counts.get("/repos/itsoltech/canopy/releases") ?? 0).toBe(before);
    const nonAdmin = githubReleaseFetch(gw.core.github, async () => false, publicFetch);
    const http = new ReleaseHttp({ fetch: nonAdmin, cacheScope: nonAdmin.cacheScope });
    expect(await http.text(api)).toContain("v1.0.0");
    expect(fixture.counts.get("/repos/itsoltech/canopy/releases") ?? 0).toBe(before);
    expect(publicCredentials).toBe(false);
  });

  test("an expired or disconnected account gives public releases without waiting for token refresh", async () => {
    fixture.advance(8 * 60 * 60_000);
    const refreshes = fixture.refreshes;
    const start = performance.now();
    expect(await releaseHttp().text(api)).toContain("v1.0.0");
    expect(performance.now() - start).toBeLessThan(2000);
    expect(fixture.refreshes).toBe(refreshes);
    await gw.api.disconnectGitHubAccount({ accountId: account });
    expect(await releaseHttp().text(api)).toContain("v1.0.0");
    expect(publicCredentials).toBe(false);
  });
});

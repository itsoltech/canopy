/** Nightly hygiene against a fake GitHub API and registry: exactly which releases and GHCR versions go. */
import { afterAll, expect, test } from "bun:test";
import { runHygiene, type Release } from "./prune-nightly.ts";

const NOW = Date.parse("2026-11-03T12:00:00Z");
const ago = (hours: number) => new Date(NOW - hours * 3_600_000).toISOString();
const INDEX = "application/vnd.oci.image.index.v1+json";
const IMAGE = "application/vnd.oci.image.manifest.v1+json";

function releases() {
  let id = 0;

  const release = (tag: string, complete: boolean, hours = 48, extra: Partial<Release> = {}) => ({
    id: ++id,
    tag_name: tag,
    draft: false,
    prerelease: true,
    created_at: ago(hours),
    published_at: ago(hours),
    assets: complete ? [{ name: "checksums.txt" }, { name: "manifest.json" }] : [{ name: "checksums.txt" }],
    ...extra,
  });

  return [
    ...[1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 13].map((n) => release(`v0.3.0-nightly.${n}`, true, 100 - n)),
    release("v0.3.0-nightly.7", false), // incomplete, old, newer complete exist → deleted
    release("v0.3.0-nightly.12", false, 1), // incomplete, inside the grace period → kept
    release("v0.3.0-nightly.14", false), // incomplete, no newer complete nightly → kept
    release("v0.3.0-nightly.15", true, 1, { draft: true }),
    release("v0.2.0-beta.1", true, 200, { prerelease: true }),
    release("v0.1.0", true, 300, { prerelease: false }),
  ];
}

/** Gateway versions: [id, digest, tags, hours since update, manifest]. */
function gatewayVersions() {
  const index = (children: string[], version?: string) => ({
    mediaType: INDEX,
    manifests: children.map((digest) => ({ digest })),
    ...(version && { annotations: { "org.opencontainers.image.version": version } }),
  });

  const image = { mediaType: IMAGE, layers: [] };

  const rows: [number, string, string[], number, object][] = [
    [
      1,
      "sha256:n1",
      ["v0.3.0-nightly.1"],
      90,
      index(["sha256:n1-amd64", "sha256:n1-arm64", "sha256:n1-att"], "0.3.0-nightly.1"),
    ],
    [2, "sha256:n1-amd64", [], 90, image],
    [3, "sha256:n1-arm64", [], 90, image],
    [4, "sha256:n1-att", [], 90, image],
    [5, "sha256:n7", ["v0.3.0-nightly.7"], 48, index(["sha256:n7-amd64", "sha256:shared"])],
    [6, "sha256:n7-amd64", [], 48, image],
    [7, "sha256:shared", [], 48, image],
    [8, "sha256:stale-alias", [], 40, index(["sha256:shared"])], // untagged old alias index: keeps what it references
    [9, "sha256:old", ["v0.2.0-nightly.3"], 500, index(["sha256:old-amd64"])], // its release was pruned long ago
    [10, "sha256:old-amd64", [], 500, image],
    [11, "sha256:n13", ["v0.3.0-nightly.13", "nightly"], 87, index(["sha256:n13-amd64"], "0.3.0-nightly.13")],
    [12, "sha256:n13-amd64", [], 87, image],
    [13, "sha256:n12", ["v0.3.0-nightly.12"], 1, index([])],
    [14, "sha256:n2", ["v0.3.0-nightly.2"], 98, index(["sha256:n2-amd64"])],
    [15, "sha256:n2-amd64", [], 98, image],
    [16, "sha256:mixed", ["v0.2.0-nightly.4", "v0.2"], 400, index([])], // carries a non-nightly tag
    [17, "sha256:aliased", ["v0.2.0-nightly.8"], 400, index([])], // the stray alias below names it
    [18, "sha256:stray", ["latest"], 400, index([], "0.2.0-nightly.8")],
    [19, "sha256:fresh", ["v0.2.0-nightly.6"], 1, index(["sha256:fresh-amd64"])], // updated inside the grace period
    [20, "sha256:fresh-amd64", [], 400, image],
    [21, "sha256:beta", ["v0.2.0-beta.1", "beta"], 200, index([])],
    [22, "sha256:stable", ["v0.1.0", "v0.1", "v0", "stable"], 300, index([])],
    [23, "sha256:cache", ["buildcache"], 300, image],
    [24, "sha256:orphan", [], 600, image], // unreferenced untagged: origin unknown, stays
  ];

  return rows;
}

function fakeGitHub() {
  const deletes: string[] = [];
  const rows = gatewayVersions();

  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      const path = url.pathname;

      if (request.method === "DELETE") {
        deletes.push(path);

        return new Response(null, { status: 204 });
      }

      if (path === "/repos/itsoltech/canopy/releases") {
        // Two pages, so pagination is exercised.
        const all = releases(),
          page = Number(url.searchParams.get("page") ?? 1);

        const headers: Record<string, string> =
          page === 1 ? { link: `<${url.origin}${path}?per_page=100&page=2>; rel="next"` } : {};

        return Response.json(page === 1 ? all.slice(0, 8) : all.slice(8), { headers });
      }

      // canopy-web is retired: same prunable rows, never touched.
      if (
        path === "/orgs/itsoltech/packages/container/canopy-gateway/versions" ||
        path === "/orgs/itsoltech/packages/container/canopy-web/versions"
      )
        return Response.json(
          rows.map(([id, name, tags, hours]) => ({
            id,
            name,
            created_at: ago(600),
            updated_at: ago(hours),
            metadata: { package_type: "container", container: { tags } },
          })),
        );

      if (path === "/orgs/itsoltech/packages/container/canopy-worker/versions")
        return Response.json({ message: "Package not found." }, { status: 404 });

      if (path === "/token")
        return request.headers.get("authorization")?.startsWith("Basic ")
          ? Response.json({ token: "registry-token" })
          : new Response(null, { status: 401 });
      const manifest = path.match(/^\/v2\/itsoltech\/canopy-gateway\/manifests\/(.+)$/);

      if (manifest) {
        if (request.headers.get("authorization") !== "Bearer registry-token")
          return new Response(null, { status: 401 });
        const row = rows.find(([, digest]) => digest === manifest[1]);

        return row
          ? Response.json(row[4], { headers: { "content-type": (row[4] as { mediaType: string }).mediaType } })
          : new Response(null, { status: 404 });
      }

      return new Response("unexpected", { status: 500 });
    },
  });

  return { server, deletes, url: `http://127.0.0.1:${server.port}` };
}

const servers: { stop: (force?: boolean) => void }[] = [];

afterAll(() => {
  for (const server of servers) server.stop(true);
});

async function run(dryRun: boolean) {
  const fake = fakeGitHub();
  servers.push(fake.server);
  const lines: string[] = [];
  const errors: string[] = [];
  const error = console.error;
  console.error = (line: string) => errors.push(line);

  try {
    const result = await runHygiene({
      apiUrl: fake.url,
      registryUrl: fake.url,
      token: "fake-token",
      repository: "itsoltech/canopy",
      dryRun,
      now: NOW,
      log: (line) => lines.push(line),
    });

    return { result, deletes: fake.deletes, lines, errors };
  } finally {
    console.error = error;
  }
}

test("hygiene deletes old and abandoned nightlies and only the GHCR versions nobody else references", async () => {
  const { result, deletes, lines } = await run(false);
  const releaseIds = Object.fromEntries(releases().map((release) => [release.id, release.tag_name]));
  expect(
    deletes
      .filter((path) => path.startsWith("/repos/"))
      .map((path) => releaseIds[Number(path.split("/").at(-1))])
      .sort(),
  ).toEqual(["v0.3.0-nightly.1", "v0.3.0-nightly.7"]);
  expect(result.deletedReleases.sort()).toEqual(["v0.3.0-nightly.1", "v0.3.0-nightly.7"]);

  const gateway = deletes
    .filter((path) => path.includes("canopy-gateway"))
    .map((path) => Number(path.split("/").at(-1)));

  // n1 with its platform and attestation manifests, n7 without the manifest the stale alias index still references, the
  // long-pruned v0.2.0-nightly.3; each index after its children.
  expect(gateway.toSorted((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 9, 10]);

  for (const [index, children] of [
    [1, [2, 3, 4]],
    [5, [6]],
    [9, [10]],
  ] as const)
    for (const child of children) expect(gateway.indexOf(child)).toBeLessThan(gateway.indexOf(index));
  expect(deletes.some((path) => /canopy-(web|worker)/.test(path))).toBe(false);
  // The retired canopy-web image keeps every existing version (docs/release.md, "Retencja nightly").
  expect(result.deletedVersions).not.toHaveProperty("canopy-web");
  // Missing package access is reported clearly; the releases were pruned anyway.
  expect(result.errors).toHaveLength(1);
  expect(result.errors[0]).toContain("GHCR canopy-worker: no access to package versions");
  expect(result.errors[0]).toContain("Admin role");
  expect(lines.join("\n")).not.toContain("fake-token");
});

test("dry run plans the same deletions and deletes nothing", async () => {
  const { result, deletes, lines } = await run(true);
  expect(deletes).toEqual([]);
  expect(result.deletedReleases.sort()).toEqual(["v0.3.0-nightly.1", "v0.3.0-nightly.7"]);
  expect(
    result.deletedVersions["canopy-gateway"]!.map((label) => Number(label.split(" ")[0])).sort((a, b) => a - b),
  ).toEqual([1, 2, 3, 4, 5, 6, 9, 10]);
  expect(lines.filter((line) => line.includes("would delete"))).toHaveLength(10);
  expect(lines.some((line) => line.startsWith("deleted"))).toBe(false);
});

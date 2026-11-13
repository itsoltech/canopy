import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { github } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { Code, ConnectError } from "@connectrpc/connect";
import { GatewayStore } from "@canopy/gateway/store";
import { GitHubAccounts } from "../../apps/gateway/src/github/service.ts";
import { pullRequestImage } from "../../apps/gateway/src/github/images.ts";
import { startTestGateway, type TestGateway } from "./support/gateway.ts";
import { linkedRead, readFixture } from "./support/github-read.ts";

const original = "https://github.com/user-attachments/assets/fixture-image";
const signed = "https://private-user-images.githubusercontent.com/1/image.png?jwt=fixture-signature";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
  "base64",
);

describe.skipIf(!dockerAvailable)("owner-scoped GitHub content images", () => {
  let gw: TestGateway;
  let pr: string;
  let downloads = 0;

  const fixture = readFixture((query, variables) => {
    if (!query.includes("CanopyImageContent")) return;

    return Response.json({
      data: {
        rateLimit: { cost: 1, remaining: 4999, resetAt: "2026-12-01T00:00:00Z" },
        node: {
          pullRequest: { id: variables["id"] === "FOREIGN" ? "PR_other" : "PR_fixture_42" },
          bodyHTML: `<a href="${original}"><img src="${signed}"></a>`,
        },
      },
    });
  });

  const transport: typeof fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (String(input).startsWith("https://private-user-images.githubusercontent.com/")) {
        downloads++;
        expect(new Headers(init?.headers).has("authorization")).toBe(false);
        expect(init?.redirect).toBe("manual");

        return new Response(png, { headers: { "content-type": "image/png" } });
      }

      return fixture.options.fetch!(input, init);
    },
    { preconnect: fetch.preconnect },
  );

  beforeAll(async () => {
    gw = await startTestGateway({ github: { ...fixture.options, fetch: transport } });
    ({ pr } = await linkedRead(gw, fixture));
  }, 60_000);
  afterAll(async () => {
    await gw?.close();
    fixture.close();
  });

  test("resolves signed URLs in the gateway, caches raster bytes and exposes no signed URL", async () => {
    const request = { pullRequestId: pr, contentId: "COMMENT", url: original };
    const value = await gw.api.getPullRequestImage(request);
    expect(value.dataUrl).toBe(`data:image/png;base64,${png.toString("base64")}`);
    expect(JSON.stringify(value)).not.toContain("fixture-signature");
    await gw.api.getPullRequestImage(request);
    expect(downloads).toBe(1);
  });

  test("refuses content from another PR and URLs absent from the containing comment", async () => {
    for (const request of [
      { pullRequestId: pr, contentId: "FOREIGN", url: original },
      { pullRequestId: pr, contentId: "COMMENT", url: "https://github.com/user-attachments/assets/other" },
    ])
      expect(ConnectError.from(await gw.api.getPullRequestImage(request).catch((e) => e)).code).toBe(Code.NotFound);
    expect(downloads).toBe(1);
  });

  test("denies a foreign owner before reading a warm image cache", async () => {
    const user = await gw.runtime.runPromise(
      GatewayStore.use((s) => s.ensureUser("foreign-image@example.test", "Foreign")),
    );

    const foreign = new GitHubAccounts(gw.runtime, user, fixture.options);

    try {
      const result = await pullRequestImage(
        foreign.prs,
        create(github.PullRequestImageRequestSchema, { pullRequestId: pr, contentId: "COMMENT", url: original }),
      ).catch((e) => e);

      expect(ConnectError.from(result).code).toBe(Code.NotFound);
      expect(downloads).toBe(1);
    } finally {
      await foreign.stop();
    }
  });

  test("disconnect revokes access to cached bytes", async () => {
    const accounts = await gw.api.listGitHubAccounts({});
    await gw.api.disconnectGitHubAccount({ accountId: accounts.accounts[0]!.id });

    const result = await gw.api
      .getPullRequestImage({ pullRequestId: pr, contentId: "COMMENT", url: original })
      .catch((e) => e);

    expect(result).toBeInstanceOf(ConnectError);
    expect(downloads).toBe(1);
  });
});

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { dockerAvailable } from "@canopy/db/testing";
import { Code, ConnectError } from "@connectrpc/connect";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { create, toJsonString } from "@bufbuild/protobuf";
import { github } from "@canopy/contracts";
import { GitHubAccounts } from "../../apps/gateway/src/github/service.ts";
import { readScope } from "../../apps/gateway/src/github/read-scope.ts";
import { timeline } from "../../apps/gateway/src/github/timeline-query.ts";
import { GatewayStore } from "@canopy/gateway/store";
import { eventually, startTestGateway, type TestGateway } from "./support/gateway.ts";
import { linkedRead, readFixture, readHead } from "./support/github-read.ts";

describe.skipIf(!dockerAvailable)("GitHub full-read security and composer handoff", () => {
  const fixture = readFixture();
  let gw: TestGateway;
  let pr: string;
  let thread: string;
  let storageCalls = 0;
  let storageAuthorized = false;

  const injectedFetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL(String(input));

      if (url.hostname === "productionresultssa1.blob.core.windows.net") {
        storageCalls++;
        const headers = new Headers(init?.headers);
        storageAuthorized ||= headers.has("authorization") || headers.has("cookie");
        expect(init?.redirect).toBe("manual");
        expect(init?.credentials).toBe("omit");

        return new Response("Storage log\n");
      }

      return fixture.options.fetch!(input, init);
    },
    { preconnect: fetch.preconnect },
  );

  beforeAll(async () => {
    gw = await startTestGateway({ github: { ...fixture.options, fetch: injectedFetch } });
    ({ pr, thread } = await linkedRead(gw, fixture));
  }, 60_000);
  afterAll(async () => {
    await gw?.close();
    fixture.close();
  });

  test("redacts secrets and terminal controls before cache and pages logs within 64 KiB/1000 lines", async () => {
    const page = await gw.api.getPullRequestJobLog({ pullRequestId: pr, resourceId: "1" });
    expect(page.text).not.toContain("\u001b");
    expect(page.text).not.toContain("private-value");
    expect(page.text).toContain("[redacted]");
    expect(Buffer.byteLength(page.text)).toBeLessThanOrEqual(65_536);
    expect(page.text.split("\n").length).toBeLessThanOrEqual(1001);
    let cursor = page.page!.nextCursor;
    let pages = 1;

    while (cursor) {
      const next = await gw.api.getPullRequestJobLog({ pullRequestId: pr, resourceId: "1", cursor });
      expect(Buffer.byteLength(next.text)).toBeLessThanOrEqual(65_536);
      expect(fixture.secrets.some((s) => next.text.includes(s))).toBe(false);
      cursor = next.page?.nextCursor ?? "";
      pages++;
    }

    expect(pages).toBeGreaterThan(2);

    const cache = await gw.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        return yield* sql<{
          text: string;
        }>`SELECT payload::text AS text FROM github_pr_cache WHERE cache_key LIKE 'logs:%'`;
      }),
    );

    expect(cache.some((r) => fixture.secrets.some((s) => r.text.includes(s)))).toBe(false);

    const wrongJob = await gw.api
      .getPullRequestJobLog({ pullRequestId: pr, resourceId: "2", cursor: page.page!.nextCursor })
      .catch((e) => e);

    expect(ConnectError.from(wrongJob).code).toBe(Code.FailedPrecondition);
  });

  test("rejects SSRF redirects and strips every credential on approved storage redirects", async () => {
    const bad = [
      "http://127.0.0.1/log",
      "https://127.0.0.1/log",
      "https://example.test/log",
      "https://productionresultssa1.blob.core.windows.net.evil.test/log",
      "https://user:pass@productionresultssa1.blob.core.windows.net/log",
    ];

    for (const [i, url] of bad.entries()) {
      fixture.logRedirect(url);

      const denied = await gw.api
        .getPullRequestJobLog({ pullRequestId: pr, resourceId: String(10 + i) })
        .catch((e) => e);

      expect(ConnectError.from(denied).code).toBe(Code.Unavailable);
    }

    expect(storageCalls).toBe(0);
    fixture.logRedirect("https://productionresultssa1.blob.core.windows.net/fixed?sig=fixture-signed-value");
    const allowed = await gw.api.getPullRequestJobLog({ pullRequestId: pr, resourceId: "20" });
    expect(allowed.text).toContain("Storage log");
    expect(storageCalls).toBe(1);
    expect(storageAuthorized).toBe(false);
    expect(toJsonString(github.PullRequestJobLogPageSchema, allowed)).not.toContain("fixture-signed-value");
    fixture.logRedirect("");
  });

  test("caps oversized downloads and lines without automatically fetching a run archive", async () => {
    fixture.logs("x".repeat(8 * 1024 * 1024 + 64));
    const bytes = await gw.api.getPullRequestJobLog({ pullRequestId: pr, resourceId: "21" });
    expect(bytes.truncated).toBe(true);
    expect(Buffer.byteLength(bytes.text)).toBeLessThanOrEqual(65_536);
    fixture.logs("line\n".repeat(50_100));
    const lines = await gw.api.getPullRequestJobLog({ pullRequestId: pr, resourceId: "22" });
    expect(lines.truncated).toBe(true);
    expect(lines.page?.detail).toContain("Log truncated");
    expect([...fixture.counts.keys()].some((p) => p.includes("/actions/runs/123/logs"))).toBe(false);
  });

  test("prepares three bounded untrusted contexts, then sends one only through the existing attachment/harness path", async () => {
    const contexts = [];
    const started = gw.worker.started.size;

    for (const action of ["question", "explain", "findings"]) {
      const context = await gw.api.preparePullRequestContext({ pullRequestId: pr, threadId: thread, action });
      contexts.push(context);
      expect(context.scope).toContain(readHead.slice(0, 7));
      const file = await gw.api.getAttachment({ attachmentId: context.attachment!.id });
      const text = Buffer.from(file.data).toString();
      expect(text).toContain("Untrusted GitHub data");
      expect(text).toContain("Snapshot SHA-256:");
      expect(text).toContain("Omitted:");
      expect(text).not.toContain("Storage log");
      expect(fixture.secrets.some((s) => text.includes(s))).toBe(false);
      expect(file.data.byteLength).toBeLessThanOrEqual(327_680);
    }

    expect(gw.worker.started.size).toBe(started);

    const sent = await gw.api.sendMessage({
      threadId: thread,
      text: "Explain this change.",
      clientRequestId: crypto.randomUUID(),
      attachmentIds: [contexts[1]!.attachment!.id],
    });

    expect(sent.turn!.platformNote).toContain("untrusted");

    const input = await eventually(
      async () => gw.worker.started.get(sent.turn!.id),
      (v) => !!v,
    );

    expect(input!.attachments).toHaveLength(1);
    expect(input!.attachments[0]!.attachmentId).toBe(contexts[1]!.attachment!.id);
    const fetched = await gw.worker.fetchBlob(thread, contexts[1]!.attachment!.sha256);
    expect(Buffer.from(fetched.data!).toString()).toContain("Untrusted GitHub data");
  }, 60_000);

  test("authorizes before serving a private cached page or preparing context", async () => {
    const user = await gw.runtime.runPromise(
      GatewayStore.use((s) => s.ensureUser("read-foreign@example.test", "Foreign")),
    );

    const foreign = new GitHubAccounts(gw.runtime, user, fixture.options);

    try {
      const result = await readScope(
        foreign.prs,
        create(github.PullRequestPageRequestSchema, { pullRequestId: pr }),
        "timeline",
      )
        .then(timeline)
        .catch((e) => e);

      expect(ConnectError.from(result).code).toBe(Code.NotFound);

      const otherThread = await gw.api
        .preparePullRequestContext({ pullRequestId: pr, threadId: crypto.randomUUID(), action: "question" })
        .catch((e) => e);

      expect(ConnectError.from(otherThread).code).toBe(Code.NotFound);
    } finally {
      await foreign.stop();
    }
  });
});

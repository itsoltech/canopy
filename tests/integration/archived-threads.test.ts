import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { dockerAvailable } from "@open-agents/db/testing";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { failure, startTestGateway, type TestGateway } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("paged archived sidebar threads", () => {
  let gw: TestGateway;
  let alpha: string;
  let beta: string;
  let active: string;
  let child: string;
  beforeAll(async () => {
    gw = await startTestGateway();
    alpha = (await gw.api.createProject({ name: "Archive Alpha" })).project!.id;
    beta = (await gw.api.createProject({ name: "Archive Beta" })).project!.id;
    active = Bun.randomUUIDv7();
    child = Bun.randomUUIDv7();
    await gw.runtime.runPromise(Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      // Deliberate ties and microsecond differences exercise keyset boundaries without Date rounding.
      for (let i = 0; i < 55; i++) {
        const id = Bun.randomUUIDv7();
        yield* sql`INSERT INTO threads (id, root_thread_id, project_id, owner_user_id, kind, runtime, provider, title, status, archived_at)
          VALUES (${id}::uuid, ${id}::uuid, ${i < 50 ? alpha : beta}::uuid, ${gw.userId}::uuid, 'main', 'gateway', 'openai',
            ${`Archived ${i} ${i % 2 === 0 ? "needle" : "ordinary"}`}, 'archived', '2026-01-01T00:00:00Z'::timestamptz + (${i % 3} * interval '1 microsecond'))`;
      }
      yield* sql`INSERT INTO threads (id, root_thread_id, project_id, owner_user_id, kind, runtime, provider, title, status)
        VALUES (${active}::uuid, ${active}::uuid, ${alpha}::uuid, ${gw.userId}::uuid, 'main', 'gateway', 'openai', 'Active parent', 'idle')`;
      yield* sql`INSERT INTO threads (id, root_thread_id, parent_thread_id, depth, project_id, owner_user_id, kind, runtime, provider, title, status, archived_at)
        VALUES (${child}::uuid, ${active}::uuid, ${active}::uuid, 1, ${alpha}::uuid, ${gw.userId}::uuid, 'side', 'gateway', 'openai', 'Previous helper', 'archived', now())`;
    }));
  }, 60_000);
  afterAll(async () => { await gw?.close(); }, 30_000);

  test("20 + 20 + 15, stable boundaries, total and count-only", async () => {
    const first = await gw.api.listArchivedThreads({});
    const second = await gw.api.listArchivedThreads({ pageToken: first.nextPageToken });
    const third = await gw.api.listArchivedThreads({ pageToken: second.nextPageToken });
    expect([first.threads.length, second.threads.length, third.threads.length]).toEqual([20, 20, 15]);
    expect([first.totalCount, second.totalCount, third.totalCount]).toEqual([55, 55, 55]);
    expect(new Set([...first.threads, ...second.threads, ...third.threads].map((t) => t.id)).size).toBe(55);
    expect(third.nextPageToken).toBe("");
    expect((await gw.api.listArchivedThreads({})).threads).toEqual(first.threads);
    const count = await gw.api.listArchivedThreads({ countOnly: true });
    expect([count.totalCount, count.threads.length, count.nextPageToken]).toEqual([55, 0, ""]);
    expect((await gw.api.listArchivedThreads({ pageSize: 1000 })).threads).toHaveLength(55);
  });

  test("project intersection, literal case-insensitive title/project query and scoped tokens", async () => {
    const filtered = await gw.api.listArchivedThreads({ projectIds: [alpha], query: " NEEDLE ", pageSize: 20 });
    expect(filtered.totalCount).toBe(25);
    const rest = await gw.api.listArchivedThreads({ projectIds: [alpha], query: "needle", pageToken: filtered.nextPageToken });
    expect(rest.threads).toHaveLength(5);
    expect((await gw.api.listArchivedThreads({ projectIds: [beta], query: "ALPHA" })).totalCount).toBe(0);
    expect((await gw.api.listArchivedThreads({ projectIds: [alpha, beta], query: "bEtA" })).totalCount).toBe(5);
    expect((await gw.api.listArchivedThreads({ query: "%" })).totalCount).toBe(0);
    expect(await failure(gw.api.listArchivedThreads({ pageToken: filtered.nextPageToken }))).toContain("page token");
    expect(await failure(gw.api.listArchivedThreads({ pageToken: "bogus" }))).toContain("page token");
    expect(await failure(gw.api.listArchivedThreads({ projectIds: ["bad"] }))).toContain("project filter");
  });

  test("index keeps Previous agents without bulk archive; parent lifecycle updates eligibility", async () => {
    const index = await gw.api.listThreads({ sidebarOnly: true, includeArchived: true });
    expect(new Set(index.threads.map((t) => t.id))).toEqual(new Set([active, child]));
    await gw.api.setThreadArchived({ threadId: active, archived: true });
    expect((await gw.api.listArchivedThreads({ countOnly: true })).totalCount).toBe(56);
    const page = await gw.api.listArchivedThreads({});
    expect(page.threads.some((t) => t.id === active)).toBe(true);
    expect(page.threads.some((t) => t.id === child)).toBe(false);
    expect(page.sideThreads.map((t) => t.id)).toEqual([child]);
    expect((await gw.api.listThreads({ sidebarOnly: true })).threads).toEqual([]);
    await gw.api.setThreadArchived({ threadId: active, archived: false });
    expect((await gw.api.listArchivedThreads({ countOnly: true })).totalCount).toBe(55);
    await gw.api.deleteThread({ threadId: active });
    expect((await gw.api.listArchivedThreads({ countOnly: true })).totalCount).toBe(55);
  });
});

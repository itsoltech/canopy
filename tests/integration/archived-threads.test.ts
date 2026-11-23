import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { dockerAvailable } from "@canopy/db/testing";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { failure, startTestGateway, type TestGateway } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("paged archived sidebar threads", () => {
  let gw: TestGateway;
  let alpha: string;
  let beta: string;
  let active: string;
  let child: string;
  let secondWorker: string;
  beforeAll(async () => {
    gw = await startTestGateway();
    alpha = (await gw.api.createProject({ name: "Archive Alpha" })).project!.id;
    beta = (await gw.api.createProject({ name: "Archive Beta" })).project!.id;
    const registered = await gw.addWorker("Other archive worker", ["/repo"]);
    secondWorker = registered.workerId;
    await gw.connect(secondWorker, registered.credential);

    const placements = await Promise.all(
      [gw.workerId, secondWorker].map(async (workerId) => ({
        workerId,
        workspaceId: (await gw.api.createWorkspace({ projectId: alpha, workerId, rootPath: "/repo" })).workspace!.id,
      })),
    );

    const primary = placements[0]!;
    active = Bun.randomUUIDv7();
    child = Bun.randomUUIDv7();
    await gw.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        // Deliberate ties and microsecond differences exercise keyset boundaries without Date rounding.
        for (let i = 0; i < 55; i++) {
          const id = Bun.randomUUIDv7();
          const placement = i < 50 ? placements[i % 3] : undefined;
          yield* sql`INSERT INTO threads (id, root_thread_id, project_id, owner_user_id, kind, runtime, provider,
            worker_id, workspace_id, cwd, title, status, archived_at)
          VALUES (${id}::uuid, ${id}::uuid, ${i < 50 ? alpha : beta}::uuid, ${gw.userId}::uuid, 'main',
            ${placement ? "worker" : "gateway"}, ${placement ? "codex" : "openai"},
            ${placement?.workerId ?? null}::uuid, ${placement?.workspaceId ?? null}::uuid, ${placement ? "/repo" : null},
            ${`Archived ${i} ${i % 2 === 0 ? "needle" : "ordinary"}`}, 'archived', '2026-01-01T00:00:00Z'::timestamptz + (${i % 3} * interval '1 microsecond'))`;
        }

        yield* sql`INSERT INTO threads (id, root_thread_id, project_id, owner_user_id, kind, runtime, provider,
          worker_id, workspace_id, cwd, title, status)
        VALUES (${active}::uuid, ${active}::uuid, ${alpha}::uuid, ${gw.userId}::uuid, 'main', 'worker', 'codex',
          ${primary.workerId}::uuid, ${primary.workspaceId}::uuid, '/repo', 'Active parent', 'idle')`;
        yield* sql`INSERT INTO threads (id, root_thread_id, parent_thread_id, depth, project_id, owner_user_id,
          kind, runtime, provider, worker_id, workspace_id, cwd, title, status, archived_at)
        VALUES (${child}::uuid, ${active}::uuid, ${active}::uuid, 1, ${alpha}::uuid, ${gw.userId}::uuid, 'side', 'worker',
          'codex', ${primary.workerId}::uuid, ${primary.workspaceId}::uuid, '/repo', 'Previous helper', 'archived', now())`;
      }),
    );
  }, 60_000);
  afterAll(async () => {
    await gw?.close();
  }, 30_000);

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

    const rest = await gw.api.listArchivedThreads({
      projectIds: [alpha],
      query: "needle",
      pageToken: filtered.nextPageToken,
    });

    expect(rest.threads).toHaveLength(5);
    expect((await gw.api.listArchivedThreads({ projectIds: [beta], query: "ALPHA" })).totalCount).toBe(0);
    expect((await gw.api.listArchivedThreads({ projectIds: [alpha, beta], query: "bEtA" })).totalCount).toBe(5);
    expect((await gw.api.listArchivedThreads({ query: "%" })).totalCount).toBe(0);
    expect(await failure(gw.api.listArchivedThreads({ pageToken: filtered.nextPageToken }))).toContain("page token");
    expect(await failure(gw.api.listArchivedThreads({ pageToken: "bogus" }))).toContain("page token");
    expect(await failure(gw.api.listArchivedThreads({ projectIds: ["bad"] }))).toContain("project filter");
  });

  test("worker selection filters archive pages and counts with projects and query", async () => {
    expect((await gw.api.getClientCapabilities({})).archiveWorkerFilter).toBe(true);

    const filters = { projectIds: [alpha], query: "needle", workerIds: [gw.workerId, secondWorker] };
    const first = await gw.api.listArchivedThreads({ ...filters, pageSize: 10 });

    const second = await gw.api.listArchivedThreads({
      ...filters,
      workerIds: [secondWorker, gw.workerId.toUpperCase(), secondWorker],
      pageToken: first.nextPageToken,
    });

    const threads = [...first.threads, ...second.threads];
    expect([first.threads.length, second.threads.length, first.totalCount, second.totalCount]).toEqual([10, 7, 17, 17]);
    expect(new Set(threads.map((t) => t.id)).size).toBe(17);
    expect(threads.filter((t) => t.workerId === gw.workerId)).toHaveLength(9);
    expect(threads.filter((t) => t.workerId === secondWorker)).toHaveLength(8);
    expect(second.nextPageToken).toBe("");
    const count = await gw.api.listArchivedThreads({ ...filters, workerIds: [gw.workerId], countOnly: true });
    expect([count.totalCount, count.threads.length, count.nextPageToken]).toEqual([9, 0, ""]);
    expect((await gw.api.listArchivedThreads({ ...filters, projectIds: [beta] })).totalCount).toBe(0);
    expect(
      await failure(
        gw.api.listArchivedThreads({ ...filters, workerIds: [gw.workerId], pageToken: first.nextPageToken }),
      ),
    ).toContain("page token");
    expect(await failure(gw.api.listArchivedThreads({ workerIds: ["bad"] }))).toContain("worker filter");
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
    const filtered = await gw.api.listArchivedThreads({ workerIds: [gw.workerId], query: "Previous helper" });
    expect(filtered.threads.map((t) => t.id)).toEqual([active]);
    expect(filtered.sideThreads.map((t) => t.id)).toEqual([child]);
    expect((await gw.api.listThreads({ sidebarOnly: true })).threads).toEqual([]);
    await gw.api.setThreadArchived({ threadId: active, archived: false });
    expect((await gw.api.listArchivedThreads({ countOnly: true })).totalCount).toBe(55);
    await gw.api.deleteThread({ threadId: active });
    expect((await gw.api.listArchivedThreads({ countOnly: true })).totalCount).toBe(55);
  });
});

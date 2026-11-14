import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { toJsonString, type JsonValue } from "@bufbuild/protobuf";
import { ItemSchema, ItemStatus, Provider, type AgentToolResult } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { GatewayStore } from "@canopy/gateway/store";
import { THREAD_VISUALS_CAPABILITY, THREAD_HTML_CAPABILITY } from "@canopy/domain/release/protocol";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { readVisual } from "../../apps/gateway/src/store/visuals.ts";
import { eventually, startTestGateway, type TestGateway } from "./support/gateway.ts";

const spec = (label = "Add worker") => ({
  schema_version: 1,
  state: { variant: "primary" },
  root: {
    type: "stack",
    children: [
      { type: "segmented", label: "Variant", state_key: "variant", options: ["primary", "secondary", "ghost"] },
      { type: "button_preview", label, variant_from: "variant" },
    ],
  },
});

interface Published {
  delivered: boolean;
  visual_id: string;
  item_id: string;
  version: number;
  citation_ref: string;
}

const json = (reply: AgentToolResult) => JSON.parse(reply.content) as Published;

describe.skipIf(!dockerAvailable)("interactive visuals over WorkerLink", () => {
  let gw: TestGateway;
  let projectId: string;
  let workspaceId: string;

  const query = <A extends object>(text: string, params: readonly string[] = []) =>
    gw.runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe<A>(text, params)));

  beforeAll(async () => {
    gw = await startTestGateway({
      worker: { hello: { capabilities: [THREAD_VISUALS_CAPABILITY, THREAD_HTML_CAPABILITY] } },
    });
    projectId = (await gw.api.createProject({ name: "Visuals" })).project!.id;
    workspaceId = (await gw.api.createWorkspace({ projectId, workerId: gw.workerId, rootPath: "/repo/visuals" }))
      .workspace!.id;
  }, 60_000);
  afterAll(async () => {
    await gw?.close();
  });

  async function turn(title = "Visual") {
    gw.worker.holdTurns = true;
    const thread = (await gw.api.createThread({ projectId, workspaceId, provider: Provider.CODEX, title })).thread!;

    await eventually(
      () => gw.api.getThread({ threadId: thread.id }),
      (r) => r.thread?.status === "idle",
    );

    const sent = (
      await gw.api.sendMessage({ threadId: thread.id, text: "Show it", clientRequestId: crypto.randomUUID() })
    ).turn!;

    await eventually(
      () => gw.runtime.runPromise(GatewayStore.use((s) => s.turnsOf(thread.id))),
      (rows) => rows.some((row) => row.id === sent.id && row.status === "running"),
    );

    return { threadId: thread.id, turnId: sent.id };
  }

  const render = (
    source: { threadId: string; turnId: string },
    args: Readonly<Record<string, JsonValue>>,
    callId = Bun.randomUUIDv7(),
  ) =>
    gw.worker.callTool({
      ...source,
      callId,
      tool: "render_visual",
      args: { title: "Button variants", description: "Compare button emphasis.", spec: spec(), ...args },
    });

  test("stores a version, announces only a manifest and replays a call once", async () => {
    const source = await turn();
    const callId = Bun.randomUUIDv7();
    const first = await render(source, { height: 420 }, callId);
    expect(first.isError).toBe(false);
    const published = json(first);
    expect(published).toMatchObject({ delivered: true, version: 1, item_id: `visual-${published.visual_id}` });

    const snapshot = await gw.runtime.runPromise(GatewayStore.use((s) => s.snapshot(source.threadId)));
    const item = snapshot.items.find((row) => row.item?.itemId === published.item_id)?.item;
    expect(item?.content.case).toBe("visual");
    expect(item?.status).toBe(ItemStatus.COMPLETED);
    expect(item && toJsonString(ItemSchema, item)).not.toContain("button_preview");

    const read = await gw.api.getVisual({ threadId: source.threadId, visualId: published.visual_id });
    expect(JSON.parse(read.specJson)).toEqual(spec());
    expect(read.visual).toMatchObject({ version: 1, height: 420, title: "Button variants", kitVersion: 1 });
    expect(read.versions).toEqual([1]);

    expect(json(await render(source, { height: 420 }, callId))).toEqual(published);
    expect(await query("SELECT 1 FROM thread_visuals WHERE visual_id=$1::uuid", [published.visual_id])).toHaveLength(1);
  });

  test("HTML is durable, owner-scoped, versioned and cannot change format", async () => {
    const source = await turn("HTML");

    const html =
      "<button>Next</button><script>document.querySelector('button').addEventListener('click', () => {});</script>";

    const publish = (args: Readonly<Record<string, JsonValue>>) =>
      gw.worker.callTool({
        ...source,
        tool: "render_html",
        args: { title: "HTML", description: "Custom interaction", html, ...args },
      });

    const first = json(await publish({}));
    const read = await gw.api.getVisual({ threadId: source.threadId, visualId: first.visual_id });
    expect(read.visual).toMatchObject({ htmlDocument: true, kitVersion: 2, version: 1 });
    expect(JSON.parse(read.specJson)).toEqual({ html });
    expect(
      json(await publish({ visual_id: first.visual_id, expected_version: 1, html: "<p>Updated</p>" })).version,
    ).toBe(2);
    expect((await publish({ visual_id: first.visual_id, expected_version: 1 })).content).toContain("Version conflict");
    expect((await render(source, { visual_id: first.visual_id, expected_version: 2 })).content).toContain(
      "Keep the visual format",
    );
    const other = await turn("Other HTML");
    await expect(gw.api.getVisual({ threadId: other.threadId, visualId: first.visual_id })).rejects.toThrow();
    await expect(
      gw.runtime.runPromise(
        Effect.flatMap(SqlClient.SqlClient, (sql) =>
          readVisual(sql, Bun.randomUUIDv7(), source.threadId, first.visual_id, 0),
        ),
      ),
    ).rejects.toThrow("visual not found");
    expect((await publish({ html: "x".repeat(512 * 1024 + 1) })).isError).toBe(true);
    const before = await query("SELECT 1 FROM thread_visuals WHERE thread_id=$1::uuid", [source.threadId]);
    const scripts = await publish({ html: "<script></script>".repeat(65) });
    expect(scripts.isError).toBe(true);
    expect(scripts.content).toContain("64 scripts");
    const depth = await publish({ html: "<div>".repeat(101) + "x" + "</div>".repeat(101) });
    expect(depth.isError).toBe(true);
    expect(depth.content).toContain("100 levels");
    expect(await query("SELECT 1 FROM thread_visuals WHERE thread_id=$1::uuid", [source.threadId])).toHaveLength(
      before.length,
    );
    expect(await query("SELECT 1 FROM thread_visuals WHERE visual_id=$1::uuid", [first.visual_id])).toHaveLength(2);
  });

  test("updates in place with an expected version and rejects conflicts and foreign visuals", async () => {
    const source = await turn();
    const first = json(await render(source, {}));

    const second = await render(source, {
      visual_id: first.visual_id,
      expected_version: 1,
      spec: spec("Remove worker"),
    });

    expect(json(second)).toMatchObject({ version: 2, item_id: first.item_id, visual_id: first.visual_id });

    const items = await query<{ c: string }>(
      "SELECT count(*)::text AS c FROM thread_items WHERE thread_id=$1::uuid AND type='visual'",
      [source.threadId],
    );

    expect(items[0]!.c).toBe("1");
    const latest = await gw.api.getVisual({ threadId: source.threadId, visualId: first.visual_id });
    expect(latest.versions).toEqual([1, 2]);
    expect(latest.specJson).toContain("Remove worker");
    const original = await gw.api.getVisual({ threadId: source.threadId, visualId: first.visual_id, version: 1 });
    expect(original.specJson).toContain("Add worker");

    const stale = await render(source, { visual_id: first.visual_id, expected_version: 1 });
    expect(stale.isError).toBe(true);
    expect(stale.content).toContain("Version conflict: this visual is at version 2");

    const other = await turn("Other");
    const foreign = await render(other, { visual_id: first.visual_id, expected_version: 2 });
    expect(foreign.isError).toBe(true);
    expect(foreign.content).toContain("Visual not found in this thread");
    await expect(gw.api.getVisual({ threadId: other.threadId, visualId: first.visual_id })).rejects.toThrow();
  });

  test("scopes reads to the owner", async () => {
    const source = await turn();
    const published = json(await render(source, {}));

    const read = (owner: string) =>
      gw.runtime.runPromise(
        Effect.flatMap(SqlClient.SqlClient, (sql) => readVisual(sql, owner, source.threadId, published.visual_id, 0)),
      );

    const [thread] = await query<{ owner_user_id: string }>("SELECT owner_user_id FROM threads WHERE id=$1::uuid", [
      source.threadId,
    ]);

    expect((await read(thread!.owner_user_id)).row.version).toBe(1);
    await expect(read(Bun.randomUUIDv7())).rejects.toThrow("visual not found");
  });

  test("validates specs strictly and applies per-turn limits", async () => {
    const source = await turn();

    const unknown = await render(source, {
      spec: { schema_version: 1, root: { type: "text", text: "x", onClick: "alert(1)" } },
    });

    expect(unknown.isError).toBe(true);
    expect(unknown.content).toContain("onClick");

    const missing = await render(source, {
      spec: { schema_version: 1, root: { type: "toggle", label: "Dark", state_key: "dark" } },
    });

    expect(missing.content).toContain('"dark" is used but not declared');

    const huge = await render(source, {
      spec: { schema_version: 1, root: { type: "code", text: "x".repeat(140_000) } },
    });

    expect(huge.content).toContain("KiB");

    for (let index = 0; index < 10; index++) expect((await render(source, {})).isError).toBe(false);
    const eleventh = await render(source, {});
    expect(eleventh.isError).toBe(true);
    expect(eleventh.content).toContain("already has 10 visuals");
  });

  test("refuses a worker without the capability and a worker's own visual items", async () => {
    const source = await turn();

    gw.worker.emit(source.threadId, source.turnId, {
      case: "itemCompleted",
      value: {
        item: {
          itemId: "visual-forged",
          status: ItemStatus.COMPLETED,
          content: { case: "visual", value: { visualId: Bun.randomUUIDv7(), version: 1, title: "Forged" } },
        },
      },
    });

    await eventually(
      () => query("SELECT 1 FROM worker_event_quarantine WHERE thread_id=$1::uuid", [source.threadId]),
      (rows) => rows.length === 1,
    );

    expect(await query("SELECT 1 FROM thread_items WHERE item_id='visual-forged'")).toHaveLength(0);

    const old = await startTestGateway();

    try {
      const project = (await old.api.createProject({ name: "Old" })).project!.id;

      const workspace = (
        await old.api.createWorkspace({ projectId: project, workerId: old.workerId, rootPath: "/repo/old" })
      ).workspace!.id;

      old.worker.holdTurns = true;

      const thread = (
        await old.api.createThread({ projectId: project, workspaceId: workspace, provider: Provider.CODEX })
      ).thread!;

      await eventually(
        () => old.api.getThread({ threadId: thread.id }),
        (r) => r.thread?.status === "idle",
      );

      const sent = (await old.api.sendMessage({ threadId: thread.id, text: "x", clientRequestId: crypto.randomUUID() }))
        .turn!;

      await eventually(
        () => old.runtime.runPromise(GatewayStore.use((s) => s.turnsOf(thread.id))),
        (rows) => rows.some((row) => row.id === sent.id && row.status === "running"),
      );

      const refused = await old.worker.callTool({
        threadId: thread.id,
        turnId: sent.id,
        tool: "render_visual",
        args: { title: "T", description: "D", spec: spec() },
      });

      expect(refused.isError).toBe(true);
      expect(refused.content).toContain("Update this computer to show visuals");
    } finally {
      await old.close();
    }
  }, 120_000);
});

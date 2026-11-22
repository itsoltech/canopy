import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PermissionMode, Provider, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import type { JsonObject } from "@canopy/domain";
import { GatewayStore } from "@canopy/gateway/store";
import { Schema } from "effect";
import { eventually, failure, startTestGateway, type ScriptedWorker, type TestGateway } from "./support/gateway.ts";
import { startInstanceFixture } from "./support/instance-fixture.ts";

const savedNote = Schema.Struct({
  note_id: Schema.String,
  scope: Schema.String,
  title: Schema.String,
  revision: Schema.Number,
});

const decodeSave = Schema.decodeSync(Schema.fromJsonString(savedNote));

const decodeSearch = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      notes: Schema.Array(
        Schema.Struct({ ...savedNote.fields, body: Schema.String, aliases: Schema.Array(Schema.String) }),
      ),
    }),
  ),
);

interface ActiveTurn {
  worker: ScriptedWorker;
  threadId: string;
  turnId: string;
}

const call = (turn: ActiveTurn, tool: string, args: JsonObject, callId?: string) =>
  turn.worker.callTool({ threadId: turn.threadId, turnId: turn.turnId, tool, args, ...(callId && { callId }) });

async function save(turn: ActiveTurn, draft: JsonObject, callId?: string) {
  const result = await call(turn, "memory_save", draft, callId);
  expect(result.isError, result.content).toBe(false);

  return decodeSave(result.content);
}

async function search(turn: ActiveTurn, ...queries: string[]) {
  const result = await call(turn, "memory_search", { queries });
  expect(result.isError, result.content).toBe(false);

  return decodeSearch(result.content).notes;
}

describe.skipIf(!dockerAvailable)("thread memory over the worker link and Settings gRPC", () => {
  let gw: TestGateway;
  let workspace: ui.Workspace;
  const running = new Set<ActiveTurn>();

  const turns = (id: string) => gw.runtime.runPromise(GatewayStore.use((s) => s.turnsOf(id)));

  async function start(workspace: ui.Workspace, worker = gw.worker, permissionMode = PermissionMode.FULL_AUTO) {
    worker.holdTurns = true;

    const { thread } = await gw.api.createThread({
      projectId: workspace.projectId,
      workspaceId: workspace.id,
      provider: Provider.CODEX,
      permissionMode: PermissionMode.FULL_AUTO,
      title: "Memory test",
    });

    const threadId = thread!.id;

    const { turn } = await gw.api.sendMessage({
      threadId,
      permissionMode,
      text: "Check this project's memory",
      clientRequestId: crypto.randomUUID(),
    });

    const actor = { worker, threadId, turnId: turn!.id };
    running.add(actor);

    // The provider reference is persisted by TurnStarted on the gateway.
    const rows = await eventually(
      () => turns(threadId),
      ([row]) => row?.status === "running" && !!row.provider_turn_ref,
    );

    expect(rows[0]).toMatchObject({ id: actor.turnId, status: "running", provider_turn_ref: expect.any(String) });

    return actor;
  }

  async function finish(actor: ActiveTurn) {
    actor.worker.finish(actor.threadId, actor.turnId);

    const rows = await eventually(
      () => turns(actor.threadId),
      ([turn]) => turn?.status === "completed",
    );

    expect(rows[0]).toMatchObject({ id: actor.turnId, status: "completed" });
    running.delete(actor);
  }

  const placement = async (projectId: string, workerId: string, rootPath: string) =>
    (await gw.api.createWorkspace({ projectId, workerId, rootPath })).workspace!;

  beforeEach(async () => {
    gw = await startTestGateway();
    const { project } = await gw.api.createProject({ name: "Shared memory" });
    workspace = await placement(project!.id, gw.workerId, "/repo/laptop");
  }, 60_000);

  afterEach(async () => {
    try {
      for (const actor of running) await finish(actor);
    } finally {
      running.clear();
      await gw?.close();
    }
  }, 30_000);

  test("a second workspace sees project notes, while worker notes require the same project and worker", async () => {
    const edge = await gw.addWorker("build server");
    const edgeWorker = await gw.connect(edge.workerId, edge.credential);
    const second = await placement(workspace.projectId, edge.workerId, "/srv/build");
    const laptop = await start(workspace);
    const build = await start(second, edgeWorker);

    const projectDraft = {
      scope: "project",
      title: "Release command",
      body: "Use the release task.",
      aliases: ["wydanie"],
    };

    const workerDraft = {
      scope: "worker",
      title: "Signing socket",
      body: "Use the login socket.",
      aliases: ["gniazdo"],
    };

    const shared = await save(laptop, projectDraft);
    const local = await save(laptop, workerDraft);
    expect(await search(build, "wydanie")).toEqual([{ ...projectDraft, ...shared }]);
    expect(await search(build, "gniazdo")).toEqual([]);
    const anotherLaptopThread = await start(workspace);
    expect(await search(anotherLaptopThread, "gniazdo")).toEqual([{ ...workerDraft, ...local }]);
    const { project } = await gw.api.createProject({ name: "Independent project" });
    const otherProject = await start(await placement(project!.id, gw.workerId, "/repo/other"));
    expect(await search(otherProject, "wydanie", "gniazdo")).toEqual([]);

    const replace = {
      ...workerDraft,
      note_id: local.note_id,
      expected_revision: local.revision,
      body: "Unexpected change",
    };

    expect((await call(build, "memory_save", replace)).isError).toBe(true);
    expect((await call(otherProject, "memory_save", replace)).isError).toBe(true);
    expect((await search(laptop, "gniazdo"))[0]?.body).toBe(workerDraft.body);
    const listed = await gw.api.listMemoryNotes({ scope: ui.MemoryNoteScope.WORKER });
    expect(listed.notes).toHaveLength(1);
    expect(listed.notes[0]).toMatchObject({
      id: local.note_id,
      projectId: workspace.projectId,
      workerId: gw.workerId,
      sourceKind: "thread",
      sourceId: laptop.threadId,
      sourceTurnId: laptop.turnId,
    });
  }, 30_000);

  test("Settings edit and deletion invalidate a warm search and reject stale revisions", async () => {
    const writer = await start(workspace);
    const draft = { scope: "project", title: "Toolchain", body: "Use the installed compiler.", aliases: ["cinnabar"] };
    const saved = await save(writer, draft);
    expect(await search(writer, "cinnabar")).toEqual([{ ...draft, ...saved }]);

    const edit = {
      noteId: saved.note_id,
      expectedRevision: saved.revision,
      title: "Compiler",
      body: "Use the pinned build.",
      aliases: ["malachite"],
      pinned: true,
    };

    const edited = await gw.api.updateMemoryNote(edit);
    expect(edited).toMatchObject({ id: saved.note_id, revision: saved.revision + 1, pinned: true });
    expect(await failure(gw.api.updateMemoryNote({ ...edit, body: "Overwritten" }))).toContain("[failed_precondition]");
    expect(await failure(gw.api.deleteMemoryNote(edit))).toContain("[failed_precondition]");
    expect(await search(writer, "cinnabar")).toEqual([]);
    expect(await search(writer, "malachite")).toEqual([
      {
        note_id: saved.note_id,
        revision: edited.revision,
        scope: "project",
        title: edit.title,
        body: edit.body,
        aliases: edit.aliases,
      },
    ]);
    await gw.api.deleteMemoryNote({ noteId: saved.note_id, expectedRevision: edited.revision });
    expect(await search(writer, "malachite")).toEqual([]);
    expect((await gw.api.listMemoryNotes({})).notes).toEqual([]);
  }, 30_000);

  test("only the authenticated worker and active turn can use a saved operation ID", async () => {
    const actor = await start(workspace);
    const callId = crypto.randomUUID();
    const draft = { scope: "project", title: "Release platforms", body: "Ship both architectures." };
    const saved = await save(actor, draft, callId);
    expect(await save(actor, draft, callId)).toEqual(saved);
    expect((await call(actor, "memory_save", { ...draft, body: "Changed request" }, callId)).isError).toBe(true);
    const otherTurn = await start(workspace);
    expect((await call(otherTurn, "memory_save", draft, callId)).isError).toBe(true);
    const edge = await gw.addWorker("different actor");
    const foreign = await gw.connect(edge.workerId, edge.credential);
    expect((await call({ ...actor, worker: foreign }, "memory_save", draft, callId)).isError).toBe(true);
    expect((await call({ ...actor, turnId: crypto.randomUUID() }, "memory_save", draft, callId)).isError).toBe(true);
    await finish(actor);
    expect((await call(actor, "memory_search", { queries: ["Release"] })).isError).toBe(true);
    const listed = (await gw.api.listMemoryNotes({})).notes;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: saved.note_id, revision: 1, title: draft.title, body: draft.body });
  }, 30_000);

  test("a read-only turn can recall but cannot save, and No project has no shared memory", async () => {
    const writer = await start(workspace);
    const draft = { scope: "project", title: "Saffron", body: "Use the reviewed settings." };
    const saved = await save(writer, draft);
    const readOnly = await start(workspace, gw.worker, PermissionMode.READ_ONLY);
    expect(await search(readOnly, "Saffron")).toEqual([{ ...draft, ...saved, aliases: [] }]);
    expect((await call(readOnly, "memory_save", draft)).isError).toBe(true);
    const scratch = (await gw.api.getOverview({})).projects.find((p) => p.kind === "scratch")!;
    const visitor = await start(scratch.workspaces.find((w) => w.workerId === gw.workerId)!);
    expect((await call(visitor, "memory_search", { queries: ["Saffron"] })).isError).toBe(true);

    for (const scope of ["worker", "project"]) {
      expect((await call(visitor, "memory_save", { ...draft, scope })).isError).toBe(true);
    }

    expect((await gw.api.listMemoryNotes({})).notes.map((n) => n.id)).toEqual([saved.note_id]);
  }, 30_000);

  test("a restarted gateway reindexes the durable revision and preserves agent edits", async () => {
    const writer = await start(workspace);

    const draft = {
      scope: "worker",
      title: "Compiler cache",
      body: "Read the cache from disk.",
      aliases: ["nightjar"],
    };

    const saved = await save(writer, draft);
    expect(await search(writer, "nightjar")).toEqual([{ ...draft, ...saved }]);
    const updated = { ...draft, aliases: ["kestrel"], body: "Mount the local cache." };
    const revision = await save(writer, { ...updated, note_id: saved.note_id, expected_revision: saved.revision });
    expect(revision).toMatchObject({ note_id: saved.note_id, revision: saved.revision + 1 });
    await finish(writer);
    await gw.close(true);
    gw = await startTestGateway({ storage: gw });
    const reader = await start(workspace);
    expect(await search(reader, "nightjar")).toEqual([]);
    expect(await search(reader, "kestrel")).toEqual([{ ...updated, ...revision }]);
  }, 60_000);
});

for (const [harness, provider] of [
  ["claude", Provider.CLAUDE],
  ["codex", Provider.CODEX],
  ["grok", Provider.GROK],
] as const) {
  test.skipIf(!dockerAvailable)(
    `${harness} lists project memory tools after creation and worker restart`,
    async () => {
      const fixture = await startInstanceFixture();

      try {
        await fixture.save(provider, "thread-memory");
        const thread = await fixture.thread(provider);

        const run = async (text: string) => {
          const turn = await fixture.send(thread.id, text);
          expect((await fixture.finished(thread.id, turn.id)).status).toBe("completed");
        };

        await run("Recall project decisions");
        await fixture.restartWorker();
        await run("Recall the same decisions");
        const records = fixture.records().filter((r) => r.harness === harness && r.event === "turn");
        expect(records).toHaveLength(2);

        for (const record of records) {
          expect(record.session).toBe(thread.providerThreadId);
          expect(record.tools).toEqual(expect.arrayContaining(["memory_search", "memory_save"]));
        }
      } finally {
        await fixture.close();
      }
    },
    90_000,
  );
}

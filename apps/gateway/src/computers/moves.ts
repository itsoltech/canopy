import { create, toJson, type DescMethod, type Message } from "@bufbuild/protobuf";
import { timestampNow } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError } from "@connectrpc/connect";
import { computerLink as link, NoticeLevel, ThreadEventSchema, ui } from "@canopy/contracts";
import { nodeRef, qualifyId, splitId } from "@canopy/domain/computers";
import { Effect } from "effect";
import type { GatewayCore } from "../core/core.ts";
import { permissionModeOf } from "../store/index.ts";
import { providerOf } from "../store/instance-config.ts";
import type { Redirects } from "./redirects.ts";
import type { ComputerStore } from "./store.ts";
import {
  applyBot,
  applyThreadRows,
  botBlocker,
  commitSource,
  decideTarget,
  discardTarget,
  exportBot,
  exportThread,
  finishThread,
  freezeBot,
  freezeThread,
  localHistory,
  MoveRefused,
  moveRow,
  payloadOf,
  redirectItem,
  restoreSource,
  stage,
  threadBlocker,
  threadFamily,
  transaction,
  unfreezeSource,
  type BotRows,
  type MoveRow,
  type ThreadRowJson,
} from "./move-state.ts";

/**
 * Stage 8 of docs/linked-computers.md: "Move to…" for threads and bots between directly linked computers.
 *
 * The source (the current home) coordinates a two-phase move: it freezes the thing, sends its full state to
 * the target, which stages it, and then commits in one transaction that turns its own copy into a redirect.
 * Only after that decision does the target apply the staged state. Before the decision any failure (a lost
 * link, a restart of either side, a refusal) rolls back; after it the move only rolls forward. Both sides
 * keep a durable record and settle unfinished moves whenever the link is up, so a move converges to
 * exactly one home and every message is idempotent.
 */
const PREPARE_TIMEOUT_MS = 120_000;
const DECIDE_TIMEOUT_MS = 15_000;

/** A staged move whose decision has not arrived: the target asks the source after this long. */
const ASK_AFTER_MS = 3_000;

export type MovePhase = "frozen" | "prepared" | "committed" | "staged" | "decided";

export type MoveHost = {
  core: GatewayCore;
  redirects: Redirects;
  self(): { nodeId: string; name: string };
  name(nodeId: string): Promise<string>;
  /** A direct partner connected now and able to receive moves. */
  ready(nodeId: string): boolean;
  /** Why a partner cannot receive moves now, in the UI's words; empty when it can. */
  unavailable(nodeId: string): Promise<string>;
  call(nodeId: string, method: DescMethod, request: Message, signal: AbortSignal): AsyncGenerator<Message>;
  broadcast(items: link.MovedItem[]): void;
  /** Tests: interrupt a move at a phase (drop the link, restart a side). Throwing `MoveCrash` stops like a killed process. */
  hook?: (phase: MovePhase, move: { id: string; role: string }) => Promise<void>;
};

/** Thrown by a test hook: the process "dies" here, without any further step or rollback. */
export class MoveCrash extends Error {}

const ACTIVE = ["preparing", "prepared", "committed", "aborting"];
const ms = (date: Date | string) => BigInt(new Date(date).getTime());

export class ComputerMoves {
  #driving = new Set<string>();
  #tasks = new Set<Promise<unknown>>();
  #ticking = false;
  #closed = false;
  constructor(
    private readonly store: ComputerStore,
    private readonly host: MoveHost,
  ) {}
  get #core() {
    return this.host.core;
  }

  /** After a restart nothing is half frozen: a move this computer had not decided yet rolls back. */
  async load() {
    for (const move of await this.#rows("role='source' AND state='preparing'"))
      await unfreezeSource(this.store, move.id, "This computer restarted before the move finished.");
  }
  close() {
    this.#closed = true;

    return Promise.allSettled(this.#tasks);
  }

  async #rows(where: string, params: unknown[] = []) {
    return this.store.query<MoveRow>(
      `SELECT * FROM computer_moves WHERE owner_user_id=$1::uuid AND ${where} ORDER BY created_at, id`,
      [this.store.owner, ...params],
    );
  }
  #run<A>(task: Promise<A>) {
    this.#tasks.add(task);
    void task.then(
      () => this.#tasks.delete(task),
      () => this.#tasks.delete(task),
    );

    return task;
  }
  async #hook(phase: MovePhase, move: { id: string; role: string }) {
    await this.host.hook?.(phase, move);
  }
  async #unary<O extends Message>(nodeId: string, method: DescMethod, request: Message, timeoutMs: number): Promise<O> {
    for await (const reply of this.host.call(nodeId, method, request, AbortSignal.timeout(timeoutMs)))
      return reply as O;
    throw new ConnectError("The other computer sent no answer", Code.Internal);
  }

  // ------------------------------------------------------------------ UI: preview, start, list

  async preview(request: ui.MovePreviewRequest): Promise<ui.MovePreview> {
    const target = request.nodeId;
    const unavailable = await this.host.unavailable(target);
    const preview = create(ui.MovePreviewSchema, { nodeId: target, name: await this.host.name(target), unavailable });

    const refs = request.everything
      ? await this.#everything()
      : request.items.map((i) => ({ kind: i.kind, id: splitId(i.id).id }));

    if (request.items.some((i) => splitId(i.id).node))
      throw new ConnectError("Open it on its own computer to move it", Code.InvalidArgument);
    const inspection = unavailable ? undefined : await this.#inspect(target, refs).catch(() => undefined);

    for (const ref of refs)
      preview.items.push(
        ref.kind === "bot" ? await this.#previewBot(ref.id, inspection) : await this.#previewThread(ref.id, inspection),
      );

    if (request.everything) Object.assign(preview, await this.#configuration(target));

    return preview;
  }

  async #everything() {
    const threads = await this.store.query<{ id: string }>(
      `SELECT id FROM threads WHERE owner_user_id=$1::uuid AND kind='main' AND deleted_at IS NULL AND moved_to IS NULL ORDER BY created_at`,
      [this.store.owner],
    );

    const bots = await this.store.query<{ id: string }>(
      `SELECT id FROM bots WHERE owner_user_id=$1::uuid AND deleted_at IS NULL AND moved_to IS NULL ORDER BY created_at`,
      [this.store.owner],
    );

    return [...threads.map((t) => ({ kind: "thread", id: t.id })), ...bots.map((b) => ({ kind: "bot", id: b.id }))];
  }

  /** The target's provider instances and projects among those the items need. */
  async #inspect(target: string, refs: { kind: string; id: string }[]) {
    const instances = new Set<string>();
    const projects = new Set<string>();

    for (const ref of refs) {
      if (ref.kind === "bot") {
        const bot = (
          await this.store.query<{ provider: string; provider_instance: string }>(
            `SELECT provider, provider_instance FROM bots WHERE id=$1::uuid AND owner_user_id=$2::uuid`,
            [ref.id, this.store.owner],
          )
        )[0];

        if (bot && bot.provider_instance !== "native") instances.add(`${bot.provider}:${bot.provider_instance}`);
      } else {
        const rows = await this.store.query<{
          provider: string;
          provider_profile_id: string | null;
          project_id: string;
        }>(
          `SELECT provider, provider_profile_id, project_id FROM threads
          WHERE owner_user_id=$2::uuid AND (id=$1::uuid OR parent_thread_id=$1::uuid) AND deleted_at IS NULL`,
          [ref.id, this.store.owner],
        );

        for (const r of rows) {
          if (r.provider_profile_id) instances.add(`${r.provider}:${r.provider_profile_id}`);
          projects.add(r.project_id);
        }
      }
    }

    return this.#unary<link.MoveInspection>(
      target,
      link.ComputerMoveService.method.inspectMove,
      create(link.MoveInspectSchema, { providerInstances: [...instances], projectIds: [...projects] }),
      DECIDE_TIMEOUT_MS,
    );
  }

  async #previewThread(id: string, inspection?: link.MoveInspection) {
    const owner = this.store.owner;
    const item = create(ui.MovePreviewItemSchema, { kind: "thread", id });

    const facts = await transaction(this.store, (sql) =>
      Effect.gen(function* () {
        const { error, main, family } = yield* threadFamily(sql, owner, id);

        return { error: error || (yield* threadBlocker(sql, owner, family)), main, family };
      }),
    );

    if (!facts.main) {
      item.blocked = facts.error;

      return item;
    }

    item.title = facts.main.title;
    item.archived = Boolean(facts.main.archived_at);
    item.blocked = facts.error;

    const project = (
      await this.store.query<{ id: string; name: string }>(`SELECT id, name FROM projects WHERE id=$1::uuid`, [
        facts.main.project_id,
      ])
    )[0];

    item.projectId = project?.id ?? "";
    item.projectName = project?.name ?? "";

    const counts = (
      await this.store.query<{
        sides: number;
        schedules: number;
        files: number;
        secrets: number;
        goal: string | null;
        parent: string | null;
        instances: string[];
      }>(
        `SELECT
      (SELECT count(*)::int FROM threads WHERE parent_thread_id=$1::uuid AND deleted_at IS NULL) AS sides,
      (SELECT count(*)::int FROM schedules WHERE thread_id=ANY($2::uuid[]) AND status IN ('active','paused')) AS schedules,
      (SELECT count(*)::int FROM attachments WHERE thread_id=ANY($2::uuid[])) AS files,
      (SELECT count(*)::int FROM thread_secrets WHERE thread_id=ANY($2::uuid[]) AND status <> 'pending') AS secrets,
      (SELECT objective FROM goals WHERE thread_id=$1::uuid AND status NOT IN ('achieved','cancelled') ORDER BY created_at DESC LIMIT 1) AS goal,
      (SELECT remote_parent_ref FROM threads WHERE id=$1::uuid AND NOT remote_parent_detached) AS parent,
      (SELECT coalesce(array_agg(DISTINCT provider || ':' || provider_profile_id), '{}') FROM threads WHERE id=ANY($2::uuid[]) AND provider_profile_id IS NOT NULL) AS instances`,
        [id, facts.family],
      )
    )[0]!;

    item.moves.push("History, files and settings");

    if (counts.sides) item.moves.push(counts.sides === 1 ? "1 side thread" : `${counts.sides} side threads`);

    if (counts.schedules) item.moves.push(counts.schedules === 1 ? "1 schedule" : `${counts.schedules} schedules`);

    if (counts.files) item.moves.push(counts.files === 1 ? "1 attachment" : `${counts.files} attachments`);
    item.redo.push(
      "The agent continues in a new session with a handoff note; files of this computer's workspace stay here",
    );

    if (counts.goal) item.redo.push(`Set the goal again: ${counts.goal.slice(0, 120)}`);

    if (counts.secrets)
      item.redo.push(
        counts.secrets === 1
          ? "Enter its secret again when asked"
          : `Enter its ${counts.secrets} secrets again when asked`,
      );

    if (counts.parent) item.redo.push("Its link to a parent agent on another computer ends");
    const missing = counts.instances.filter((i) => inspection && !inspection.providerInstances.includes(i));

    if (!item.blocked && missing.length)
      item.blocked = `Share its provider instance (${missing.map((i) => i.split(":")[1]).join(", ")}) with the other computer first.`;

    return item;
  }

  async #previewBot(id: string, inspection?: link.MoveInspection) {
    const owner = this.store.owner;
    const item = create(ui.MovePreviewItemSchema, { kind: "bot", id });

    const bot = (
      await this.store.query<{
        name: string;
        provider: string;
        provider_instance: string;
        archived: boolean;
        routines: number;
        reminders: number;
      }>(
        `SELECT configuration ->> 'name' AS name, provider, provider_instance,
      archived_at IS NOT NULL AS archived,
      (SELECT count(*)::int FROM bot_routines r WHERE r.bot_id = b.id AND r.deleted_at IS NULL) AS routines,
      (SELECT count(*)::int FROM bot_wakeups w WHERE w.bot_id = b.id AND NOT w.cancelled AND NOT w.delivered) AS reminders
      FROM bots b WHERE id=$1::uuid AND owner_user_id=$2::uuid AND deleted_at IS NULL`,
        [id, owner],
      )
    )[0];

    if (!bot) {
      item.blocked = "Bot not found";

      return item;
    }

    item.title = bot.name || "Bot";
    item.archived = bot.archived;
    item.blocked = await transaction(this.store, (sql) => botBlocker(sql, owner, id));
    item.moves.push("Conversation and handoff notes");

    if (bot.routines) item.moves.push(bot.routines === 1 ? "1 routine" : `${bot.routines} routines`);

    if (bot.reminders) item.moves.push(bot.reminders === 1 ? "1 reminder" : `${bot.reminders} reminders`);
    const rows = JSON.parse((await exportBot(this.store, id, "")).rowsJson) as BotRows;

    for (const g of rows.grants) item.redo.push(`Connect ${g.name} (${g.connector_type}) again`);

    for (const m of rows.mcp) item.redo.push(`Add the MCP server ${m.name} again`);

    if (
      !item.blocked &&
      inspection &&
      bot.provider_instance !== "native" &&
      !inspection.providerInstances.includes(`${bot.provider}:${bot.provider_instance}`)
    )
      item.blocked = `Share its provider instance (${bot.provider_instance}) with the other computer first.`;

    return item;
  }

  /** Move everything: what is already shared stays shared; what is this computer's own has to be set up again. */
  async #configuration(target: string) {
    const shared = (
      await this.store
        .query<{ key: string }>(
          `SELECT key FROM computer_shared_items WHERE owner_user_id=$1::uuid AND shared ORDER BY key`,
          [this.store.owner],
        )
        .catch(() => [])
    ).map((r) => sharedLabel(r.key));

    const instances = await this.store
      .query<{ label: string; harness: string; id: string }>(
        `SELECT label, harness, id FROM provider_instances p WHERE NOT EXISTS
      (SELECT 1 FROM computer_shared_items s WHERE s.owner_user_id=$1::uuid AND s.shared AND s.key = 'instance:' || p.harness || ':' || p.id) ORDER BY label`,
        [this.store.owner],
      )
      .catch(() => []);

    const accounts = await this.store.query<{ name: string; connector_type: string }>(
      `SELECT name, connector_type FROM connector_accounts WHERE owner_user_id=$1::uuid ORDER BY name`,
      [this.store.owner],
    );

    const servers = await this.store.query<{ name: string }>(
      `SELECT name FROM bot_mcp_servers WHERE owner_user_id=$1::uuid ORDER BY name`,
      [this.store.owner],
    );

    const schedules =
      (
        await this.store.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM schedules s JOIN projects p ON p.id = s.project_id WHERE p.owner_user_id=$1::uuid AND s.target='new_thread' AND s.status IN ('active','paused')`,
          [this.store.owner],
        )
      )[0]?.n ?? 0;

    const localOnly = [
      ...instances.filter((i) => i.id !== "native").map((i) => `Provider instance ${i.label || i.id} (not shared)`),
      ...accounts.map((a) => `Connector account ${a.name} (${a.connector_type})`),
      ...servers.map((s) => `MCP server ${s.name}`),
      ...(schedules
        ? [schedules === 1 ? "1 schedule that starts new threads" : `${schedules} schedules that start new threads`]
        : []),
      "Workers, workspaces and desktop settings of this computer",
    ];

    void target;

    return { shared, localOnly };
  }

  async start(request: ui.StartMoveRequest): Promise<ui.MovesSnapshot> {
    const target = request.nodeId;
    const unavailable = await this.host.unavailable(target);

    if (unavailable) throw new ConnectError(unavailable, Code.FailedPrecondition);

    if (request.items.some((i) => splitId(i.id).node))
      throw new ConnectError("Open it on its own computer to move it", Code.InvalidArgument);
    const refs = request.everything ? await this.#everything() : request.items.map((i) => ({ kind: i.kind, id: i.id }));

    if (!refs.length) throw new ConnectError("Nothing to move", Code.InvalidArgument);

    if (refs.some((r) => !["thread", "bot"].includes(r.kind)))
      throw new ConnectError("Only threads and bots can move", Code.InvalidArgument);
    const placements = new Map<string, string>();

    for (const p of request.placements) {
      const { id, node } = splitId(p.workspaceId);

      if (node !== nodeRef(target))
        throw new ConnectError("Choose a workspace on the computer the threads move to", Code.InvalidArgument);
      placements.set(splitId(p.projectId).id, id);
    }

    const batchId = refs.length > 1 ? crypto.randomUUID() : undefined;
    const started: string[] = [];
    const all: string[] = [];

    for (const ref of refs) {
      const moveId = crypto.randomUUID();
      all.push(moveId);
      let result: { error: string };

      if (ref.kind === "thread") {
        const project =
          (
            await this.store.query<{ project_id: string }>(
              `SELECT project_id FROM threads WHERE id=$1::uuid AND owner_user_id=$2::uuid`,
              [ref.id, this.store.owner],
            )
          )[0]?.project_id ?? "";

        const workspaceId = placements.get(project);
        result = workspaceId
          ? await freezeThread(this.store, {
              moveId,
              threadId: ref.id,
              target,
              ...(batchId && { batchId }),
              placement: { workspaceId },
            })
          : { error: "Choose a workspace on the other computer for its project." };
      } else result = await freezeBot(this.store, { moveId, botId: ref.id, target, ...(batchId && { batchId }) });

      if (result.error) await this.#refused(moveId, ref, target, result.error, batchId);
      else {
        started.push(moveId);
        await this.#changed(ref.kind, ref.id);
      }
    }

    // One move at a time: a laptop's worth of threads should not compete for the link.
    void this.#run(
      (async () => {
        for (const id of started) await this.#drive(id);
      })(),
    );

    return this.list(batchId ?? "", all);
  }

  async #refused(moveId: string, ref: { kind: string; id: string }, target: string, error: string, batchId?: string) {
    const title =
      ref.kind === "bot"
        ? (
            await this.store.query<{ t: string }>(`SELECT configuration ->> 'name' AS t FROM bots WHERE id=$1::uuid`, [
              ref.id,
            ])
          )[0]?.t
        : (await this.store.query<{ t: string }>(`SELECT title AS t FROM threads WHERE id=$1::uuid`, [ref.id]))[0]?.t;

    await this.store.query(
      `INSERT INTO computer_moves(owner_user_id,id,role,peer_node_id,kind,item_id,batch_id,title,state,error) VALUES ($1::uuid,$2::uuid,'source',$3,$4,$5::uuid,$6::uuid,$7,'aborted',$8)`,
      [this.store.owner, moveId, target, ref.kind, ref.id, batchId ?? null, title ?? "", error],
    );
  }

  async list(batchId = "", ids: string[] = []): Promise<ui.MovesSnapshot> {
    const rows = batchId
      ? await this.#rows("batch_id=$2::uuid", [batchId])
      : ids.length
        ? await this.#rows("id=ANY($2::uuid[])", [ids])
        : await this.store.query<MoveRow>(
            `SELECT * FROM computer_moves WHERE owner_user_id=$1::uuid ORDER BY updated_at DESC LIMIT 100`,
            [this.store.owner],
          );

    return create(ui.MovesSnapshotSchema, {
      moves: await Promise.all(
        rows.map(async (m) =>
          create(ui.ComputerMoveSchema, {
            id: m.id,
            batchId: m.batch_id ?? "",
            kind: m.kind,
            itemId: m.item_id,
            title: m.title,
            role: m.role,
            nodeId: m.peer_node_id,
            nodeName: await this.host.name(m.peer_node_id),
            state: m.state,
            error: m.error,
            redo: m.redo,
            updatedAtMs: ms(m.updated_at),
            newId:
              m.role === "source" && ["committed", "done"].includes(m.state)
                ? qualifyId(m.item_id, m.peer_node_id)
                : m.role === "target" && m.state === "done"
                  ? m.item_id
                  : "",
          }),
        ),
      ),
    });
  }

  /** Thread and bot lists change when a thing freezes, leaves or arrives. */
  async #changed(kind: string, id: string, family: string[] = [id]) {
    if (kind === "thread") await this.#core.threadsChanged(family);
    else await this.store.query("UPDATE bots SET revision=revision+1 WHERE id=$1::uuid", [id]).catch(() => {});
  }

  // ------------------------------------------------------------------ source: drive one move

  async #drive(moveId: string) {
    if (this.#driving.has(moveId) || this.#closed) return;
    this.#driving.add(moveId);

    try {
      const move = await moveRow(this.store, moveId);

      if (move?.state !== "preparing") return;
      const target = move.peer_node_id;

      try {
        await this.#hook("frozen", move);

        const prepare = create(link.MovePrepareSchema, {
          moveId,
          kind: move.kind,
          itemId: move.item_id,
          batchId: move.batch_id ?? "",
          title: move.title,
          workspaceId: move.placement.workspaceId ?? "",
        });

        const name = this.host.self().name;

        if (move.kind === "thread")
          prepare.thread = await exportThread(
            this.store,
            (id) => this.#history(id),
            move.frozen.family ?? [move.item_id],
            move.frozen,
            name,
          );
        else prepare.bot = await exportBot(this.store, move.item_id, name);

        if (!this.host.ready(target))
          throw new MoveRefused((await this.host.unavailable(target)) || "The other computer is not connected.");

        const reply = await this.#unary<link.MoveReply>(
          target,
          link.ComputerMoveService.method.prepareMove,
          prepare,
          PREPARE_TIMEOUT_MS,
        );

        if (reply.state !== "prepared") throw new MoveRefused(reply.error || "The other computer refused the move.");
        await this.#hook("prepared", move);
      } catch (error) {
        if (error instanceof MoveCrash) return;

        // Before the decision: roll back here; the target drops what it staged.
        const reason =
          error instanceof MoveRefused
            ? error.message
            : error instanceof ConnectError
              ? error.rawMessage
              : "The move failed. Nothing changed.";

        if ((await unfreezeSource(this.store, moveId, reason)) === "aborting")
          await this.#changed(move.kind, move.item_id, move.frozen.family);
        await this.#settle(moveId).catch(() => {});

        return;
      }

      const home = { nodeId: target, name: await this.host.name(target) };

      if ((await commitSource(this.store, move, home, this.host.self().nodeId)) !== "committed") return;
      const family = move.kind === "thread" ? (move.frozen.family ?? [move.item_id]) : [move.item_id];
      this.host.broadcast(family.map((id) => redirectItem(id, move.kind, home, this.host.self().nodeId)));

      for (const id of family)
        await this.host.redirects.record(redirectItem(id, move.kind, home, this.host.self().nodeId));
      await this.#changed(move.kind, move.item_id, family);

      try {
        await this.#hook("committed", move);
      } catch {
        return;
      }

      await this.#settle(moveId).catch(() => {});
    } finally {
      this.#driving.delete(moveId);
    }
  }

  /** The thread as its home shows it (the core's snapshot, moved history included). */
  async #history(threadId: string): Promise<ui.ThreadSnapshot> {
    const abort = new AbortController();

    try {
      for await (const update of this.#core.watchThread(threadId, abort.signal))
        if (update.change.case === "snapshot") return update.change.value;
    } finally {
      abort.abort();
    }

    throw new Error("missing thread snapshot");
  }

  /** Tells the target a decision it has not confirmed yet. Retried by the tick until it does. */
  async #settle(moveId: string) {
    const move = await moveRow(this.store, moveId);

    if (
      !move ||
      move.role !== "source" ||
      !["committed", "aborting"].includes(move.state) ||
      !this.host.ready(move.peer_node_id)
    )
      return;
    const decision = move.state === "committed" ? "commit" : "abort";

    const reply = await this.#unary<link.MoveReply>(
      move.peer_node_id,
      link.ComputerMoveService.method.decideMove,
      create(link.MoveDecisionSchema, { moveId, decision }),
      DECIDE_TIMEOUT_MS,
    );

    const confirmed =
      decision === "commit"
        ? ["committed", "done"].includes(reply.state)
        : ["aborted", "missing"].includes(reply.state);

    if (confirmed)
      await this.store.query(
        `UPDATE computer_moves SET state=$3, updated_at=now() WHERE owner_user_id=$1::uuid AND id=$2::uuid AND state=$4`,
        [this.store.owner, moveId, decision === "commit" ? "done" : "aborted", move.state],
      );
  }

  // ------------------------------------------------------------------ link: served on the other side

  async serve(peer: string, method: DescMethod, request: Message): Promise<Message> {
    if (method.name === "PrepareMove") return this.#prepare(peer, request as link.MovePrepare);

    if (method.name === "DecideMove") {
      const decision = request as link.MoveDecision;

      if (!["commit", "abort"].includes(decision.decision))
        throw new ConnectError("Unknown decision", Code.InvalidArgument);
      const state = await decideTarget(this.store, peer, decision.moveId, decision.decision);
      await this.host.hook?.("decided", { id: decision.moveId, role: "target" });

      if (state === "committed") void this.#run(this.#apply(decision.moveId).catch(() => {}));

      return create(link.MoveReplySchema, { state });
    }

    if (method.name === "MoveOutcome") return this.#outcome(peer, (request as link.MoveDecision).moveId);

    if (method.name === "InspectMove") return this.#inspection(request as link.MoveInspect);
    throw new ConnectError("Unknown move method", Code.Unimplemented);
  }

  async #inspection(request: link.MoveInspect) {
    const instances = await this.store.query<{ key: string }>(
      `SELECT harness || ':' || id AS key FROM provider_instances WHERE harness || ':' || id = ANY($1::text[])`,
      [request.providerInstances.slice(0, 200)],
    );

    const projects = await this.store.query<{ id: string }>(
      `SELECT id::text FROM projects WHERE owner_user_id=$1::uuid AND id::text = ANY($2::text[]) AND archived_at IS NULL`,
      [this.store.owner, request.projectIds.slice(0, 500)],
    );

    return create(link.MoveInspectionSchema, {
      providerInstances: instances.map((i) => i.key),
      projectIds: projects.map((p) => p.id),
    });
  }

  /** The source's decision for a move the target staged. Unknown here means it never committed. */
  async #outcome(peer: string, moveId: string) {
    const move = await moveRow(this.store, moveId);

    if (!move || move.role !== "source" || move.peer_node_id !== peer)
      return create(link.MoveReplySchema, { state: "abort" });

    if (move.state === "preparing") return create(link.MoveReplySchema, { state: "preparing" });

    return create(link.MoveReplySchema, { state: ["committed", "done"].includes(move.state) ? "commit" : "abort" });
  }

  /** Validates and stages a move on this computer. Nothing here runs until the source decides. */
  async #prepare(peer: string, prepare: link.MovePrepare) {
    const reply = (error: string, state = "refused") => create(link.MoveReplySchema, { state, error });

    if (
      !/^[0-9a-f-]{36}$/.test(prepare.moveId) ||
      !/^[0-9a-f-]{36}$/.test(prepare.itemId) ||
      !["thread", "bot"].includes(prepare.kind)
    )
      return reply("Invalid move");
    const known = await moveRow(this.store, prepare.moveId);

    if (known)
      return known.role === "target" && known.peer_node_id === peer
        ? reply("", known.state === "aborted" ? "refused" : "prepared")
        : reply("Invalid move");
    let placement: { workspaceId?: string; projectId?: string } = {};
    const redo: string[] = [];

    if (prepare.kind === "thread") {
      const threads = prepare.thread?.threads ?? [];
      const rows = threads.map((t) => JSON.parse(t.rowJson) as ThreadRowJson);

      if (
        !rows.length ||
        rows[0]!.id !== prepare.itemId ||
        rows.some((r, i) => i > 0 && r.parent_thread_id !== prepare.itemId)
      )
        return reply("Invalid thread move");

      const workspace = (
        await this.store
          .query<{ project_id: string; worker_id: string }>(
            `SELECT w.project_id, w.worker_id FROM project_workspaces w JOIN projects p ON p.id = w.project_id
        WHERE w.id=$1::uuid AND p.owner_user_id=$2::uuid AND w.archived_at IS NULL AND p.archived_at IS NULL`,
            [prepare.workspaceId, this.store.owner],
          )
          .catch(() => [])
      )[0];

      if (!workspace) return reply("The chosen workspace is not on this computer.");
      placement = { workspaceId: prepare.workspaceId, projectId: workspace.project_id };

      const instances = [
        ...new Set(rows.filter((r) => r.provider_profile_id).map((r) => `${r.provider}:${r.provider_profile_id}`)),
      ];

      const have = (await this.#inspection(create(link.MoveInspectSchema, { providerInstances: instances })))
        .providerInstances;

      const missing = instances.filter((i) => !have.includes(i));

      if (missing.length)
        return reply(
          `Provider instance ${missing.map((i) => i.split(":")[1]).join(", ")} is not on this computer. Share it first.`,
        );
      redo.push("The agent continues in a new session here with a handoff note");
    } else {
      const rows = JSON.parse(prepare.bot?.rowsJson || "{}") as BotRows;

      if (rows.bot?.id !== prepare.itemId) return reply("Invalid bot move");

      if (
        rows.bot.provider_instance !== "native" &&
        !(
          await this.#inspection(
            create(link.MoveInspectSchema, {
              providerInstances: [`${rows.bot.provider}:${rows.bot.provider_instance}`],
            }),
          )
        ).providerInstances.length
      )
        return reply(`Provider instance ${rows.bot.provider_instance} is not on this computer. Share it first.`);
      redo.push(
        ...rows.grants.map((g) => `Connect ${g.name} (${g.connector_type}) again`),
        ...rows.mcp.map((m) => `Add the MCP server ${m.name} again`),
      );
    }

    const state = await stage(this.store, peer, prepare, placement, redo);

    if (state === "exists") return reply("It is already on this computer (moving a thing back is not supported yet).");

    if (state !== "prepared") return reply("Invalid move");
    await this.host.hook?.("staged", { id: prepare.moveId, role: "target" });

    return reply("", "prepared");
  }

  // ------------------------------------------------------------------ target: apply

  async #apply(moveId: string) {
    if (this.#driving.has(moveId) || this.#closed) return;
    this.#driving.add(moveId);

    try {
      const move = await moveRow(this.store, moveId);

      if (move?.role !== "target" || move.state !== "committed") return;
      const self = this.host.self();
      let ids = [move.item_id];

      try {
        if (move.kind === "bot") await applyBot(this.store, move, self);
        else ids = await this.#applyThread(move, self);
      } catch (error) {
        // The decision is final: the staged state stays and the tick tries again.
        await this.store.query(
          `UPDATE computer_moves SET error=$3, updated_at=now() WHERE owner_user_id=$1::uuid AND id=$2::uuid`,
          [this.store.owner, moveId, `Arriving: ${error instanceof Error ? error.message : "retrying"}`.slice(0, 500)],
        );

        return;
      }

      for (const id of ids) await this.host.redirects.record(redirectItem(id, move.kind, self, move.peer_node_id));
      this.host.broadcast(ids.map((id) => redirectItem(id, move.kind, self, move.peer_node_id)));
      await this.#changed(move.kind, move.item_id, ids);
    } finally {
      this.#driving.delete(moveId);
    }
  }

  async #applyThread(move: MoveRow, self: { nodeId: string; name: string }) {
    const prepare = payloadOf(move);
    const threads = prepare.thread!.threads;
    const ids = threads.map((t) => (JSON.parse(t.rowJson) as ThreadRowJson).id);

    const moved = new Set([
      ...ids,
      ...prepare.thread!.files.map((f) => String((JSON.parse(f.attachmentJson) as { id: string }).id)),
    ]);

    const workspace = (
      await this.store.query<{ project_id: string; root_path: string }>(
        `SELECT project_id, root_path FROM project_workspaces WHERE id=$1::uuid`,
        [move.placement.workspaceId],
      )
    )[0];

    if (!workspace) throw new Error("the chosen workspace was removed");
    const from = prepare.thread!.sourceName || "the other computer";

    for (const thread of threads) {
      const row = JSON.parse(thread.rowJson) as ThreadRowJson;
      const history = localHistory(thread.history!, move.peer_node_id, moved);

      const request = create(ui.CreateThreadRequestSchema, {
        projectId: workspace.project_id,
        workspaceId: move.placement.workspaceId!,
        title: row.title,
        provider: providerOf(row.provider),
        providerProfileId: row.provider_profile_id ?? "",
        model: row.settings.model ?? "",
        effort: row.settings.effort ?? "",
        permissionMode: permissionModeOf(row.settings.permissionMode || "ASK"),
        instructions: row.settings.instructions ?? "",
        parentThreadId: row.kind === "side" ? (row.parent_thread_id ?? "") : "",
        clientRequestId: `move:${move.id}:${row.id}`,
      });

      const notice = create(ThreadEventSchema, {
        eventId: crypto.randomUUID(),
        threadId: row.id,
        occurredAt: timestampNow(),
        body: {
          case: "notice",
          value: {
            level: NoticeLevel.INFO,
            code: "moved",
            message: `Moved from ${from} to ${self.name}`,
            dataJson: JSON.stringify({ from_node_id: move.peer_node_id }),
          },
        },
      });

      await this.#core.createMovedThread(request, row.id, () =>
        applyThreadRows(this.store, move, thread, {
          threadId: row.id,
          projectId: workspace.project_id,
          ordinalTurn: crypto.randomUUID(),
          history,
          handoff: handoffNote(history, {
            from,
            to: self.name,
            oldCwd: row.cwd ?? "",
            newCwd: workspace.root_path,
            title: row.title,
          }),
          notice: { eventId: notice.eventId, payload: toJson(ThreadEventSchema, notice) },
          files: prepare.thread!.files,
          blobs: prepare.thread!.blobs,
        }),
      );

      if (row.kind === "main" && row.archived_at) await this.#core.setThreadArchived(row.id, true).catch(() => {});
    }

    await finishThread(this.store, move, ids, self);

    return ids;
  }

  // ------------------------------------------------------------------ recovery

  /** Settles unfinished moves with every partner that is connected now. Called by the heartbeat. */
  async tick() {
    if (this.#ticking || this.#closed) return;
    this.#ticking = true;

    try {
      for (const move of await this.#rows(`state = ANY($2::text[])`, [ACTIVE])) {
        if (this.#closed) break;

        if (move.role === "target" && move.state === "committed") {
          await this.#apply(move.id);
          continue;
        }

        if (!this.host.ready(move.peer_node_id) || this.#driving.has(move.id)) continue;

        try {
          if (move.role === "source" && move.state === "preparing") await this.#drive(move.id);
          else if (move.role === "source") await this.#settle(move.id);
          else if (move.state === "prepared" && Date.now() - new Date(move.updated_at).getTime() > ASK_AFTER_MS) {
            const outcome = await this.#unary<link.MoveReply>(
              move.peer_node_id,
              link.ComputerMoveService.method.moveOutcome,
              create(link.MoveDecisionSchema, { moveId: move.id }),
              DECIDE_TIMEOUT_MS,
            );

            if (outcome.state === "commit" || outcome.state === "abort") {
              if ((await decideTarget(this.store, move.peer_node_id, move.id, outcome.state)) === "committed")
                await this.#apply(move.id);
            }
          }
        } catch {
          /* the link dropped again; the next heartbeat retries */
        }
      }
    } finally {
      this.#ticking = false;
    }
  }

  /**
   * Unlinking resolves every unfinished move with that computer: an undecided one rolls back, a decided one the
   * target never confirmed stays here (the source keeps its copy), and a target applies what it was told.
   */
  async unlinked(nodeId: string) {
    for (const move of await this.#rows(`peer_node_id=$2 AND state = ANY($3::text[])`, [nodeId, ACTIVE])) {
      if (move.role === "source" && move.state === "preparing") {
        await unfreezeSource(this.store, move.id, "The other computer was unlinked.", "aborted");
        await this.#changed(move.kind, move.item_id, move.frozen.family);
      } else if (move.role === "source" && move.state === "aborting")
        await this.store.query(
          `UPDATE computer_moves SET state='aborted', updated_at=now() WHERE owner_user_id=$1::uuid AND id=$2::uuid`,
          [this.store.owner, move.id],
        );
      else if (move.role === "source") {
        await restoreSource(this.store, move);
        await this.host.redirects.load();
        await this.#changed(move.kind, move.item_id, move.frozen.family);
      } else if (move.state === "prepared") await discardTarget(this.store, move);
      else await this.#apply(move.id);
    }
  }

  /** Why a write on this computer's thread or bot must wait: it is frozen for a move. */
  async frozen(ids: readonly string[]): Promise<string | undefined> {
    if (!ids.length) return undefined;

    const rows = await this.store.query<{ moved_to: string }>(
      `SELECT moved_to FROM threads WHERE id = ANY($1::uuid[]) AND moved_to IS NOT NULL AND deleted_at IS NULL
      UNION ALL SELECT moved_to FROM bots WHERE id = ANY($1::uuid[]) AND moved_to IS NOT NULL AND deleted_at IS NULL LIMIT 1`,
      [ids],
    );

    return rows[0] ? `Moving to ${await this.host.name(rows[0].moved_to)}. Try again in a moment.` : undefined;
  }
}

const sharedLabel = (key: string) => {
  const [kind, ...rest] = key.split(":");

  return kind === "instance"
    ? `Provider instance ${rest.at(-1)}`
    : kind === "models"
      ? `Models of ${rest.at(-1)}`
      : kind === "project"
        ? "A project"
        : `Settings: ${rest.join(" ").replace("_", " ")}`;
};

/**
 * The note a moved thread's agent gets in its new session's instructions, like a bot's handoff (docs/bots.md):
 * where it came from, the task, and an excerpt of the conversation, clearly marked as incomplete.
 */
export function handoffNote(
  history: ui.ThreadSnapshot,
  where: { from: string; to: string; oldCwd: string; newCwd: string; title: string },
) {
  const messages = history.items.flatMap((i) => {
    const content = i.item?.content;

    return content?.case === "userMessage"
      ? [`User: ${content.value.text}`]
      : content?.case === "agentMessage"
        ? [`Assistant: ${content.value.text}`]
        : [];
  });

  const task = history.turns.find((t) => t.messageText || t.inputText);
  const recent: string[] = [];
  let size = 0;

  for (const message of messages.slice(-30).reverse()) {
    const text = message.length > 800 ? `${message.slice(0, 800)}…` : message;

    if (size + text.length > 10_000) break;
    recent.unshift(text);
    size += text.length;
  }

  const goal =
    history.goal && !["achieved", "cancelled"].includes(history.goal.status)
      ? `\nAn open goal did not move: ${history.goal.objective.slice(0, 1000)}. It is set again only if the user asks.`
      : "";

  return (
    [
      `Handoff: this thread ("${where.title}") moved from ${where.from} to ${where.to}. Its earlier work ran in another session on ${where.from}${where.oldCwd ? `, in ${where.oldCwd}` : ""}.`,
      `That session and its files are not here. You now work in ${where.newCwd} on ${where.to}, which may differ: check the files before relying on earlier output.`,
      ...(task ? [`Original task: ${(task.messageText || task.inputText).slice(0, 2000)}`] : []),
      `Recent conversation (an excerpt; earlier messages may be missing):`,
      ...recent,
    ]
      .join("\n")
      .slice(0, 16_000) +
    goal +
    "\nContinue naturally; mention the move only if the user asks about it."
  );
}

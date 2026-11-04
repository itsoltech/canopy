import { create } from "@bufbuild/protobuf";

import { Code, ConnectError } from "@connectrpc/connect";

import { computerLink as link, ui } from "@canopy/contracts";

import { splitId } from "@canopy/domain/computers";

import { Effect } from "effect";

import { botBlocker, botRowsJson, exportBot, threadBlocker, threadFamily, transaction } from "./move-state.ts";
import { DECIDE_TIMEOUT_MS, movesState, sharedLabel } from "./moves-context.ts";
import { movesUnary } from "./moves-recovery.ts";
import type { ComputerMoves } from "./moves.ts";

export async function movesEverything(hostContext: ComputerMoves) {
  const threads = await hostContext[movesState].store.query<{ id: string }>(
    `SELECT id FROM threads WHERE owner_user_id=$1::uuid AND kind='main' AND deleted_at IS NULL AND moved_to IS NULL ORDER BY created_at`,
    [hostContext[movesState].store.owner],
  );

  const bots = await hostContext[movesState].store.query<{ id: string }>(
    `SELECT id FROM bots WHERE owner_user_id=$1::uuid AND deleted_at IS NULL AND moved_to IS NULL ORDER BY created_at`,
    [hostContext[movesState].store.owner],
  );

  return [...threads.map((t) => ({ kind: "thread", id: t.id })), ...bots.map((b) => ({ kind: "bot", id: b.id }))];
}

/** The target's provider instances and projects among those the items need. */
export async function movesInspect(hostContext: ComputerMoves, target: string, refs: { kind: string; id: string }[]) {
  const instances = new Set<string>();
  const projects = new Set<string>();

  for (const ref of refs) {
    if (ref.kind === "bot") {
      const bot = (
        await hostContext[movesState].store.query<{ provider: string; provider_instance: string }>(
          `SELECT provider, provider_instance FROM bots WHERE id=$1::uuid AND owner_user_id=$2::uuid`,
          [ref.id, hostContext[movesState].store.owner],
        )
      )[0];

      if (bot && bot.provider_instance !== "native") instances.add(`${bot.provider}:${bot.provider_instance}`);
    } else {
      const rows = await hostContext[movesState].store.query<{
        provider: string;
        provider_profile_id: string | null;
        project_id: string;
      }>(
        `SELECT provider, provider_profile_id, project_id FROM threads
          WHERE owner_user_id=$2::uuid AND (id=$1::uuid OR parent_thread_id=$1::uuid) AND deleted_at IS NULL`,
        [ref.id, hostContext[movesState].store.owner],
      );

      for (const r of rows) {
        if (r.provider_profile_id) instances.add(`${r.provider}:${r.provider_profile_id}`);
        projects.add(r.project_id);
      }
    }
  }

  return movesUnary<link.MoveInspection>(
    hostContext,
    target,
    link.ComputerMoveService.method.inspectMove,
    create(link.MoveInspectSchema, { providerInstances: [...instances], projectIds: [...projects] }),
    DECIDE_TIMEOUT_MS,
  );
}

export async function movesPreviewThread(hostContext: ComputerMoves, id: string, inspection?: link.MoveInspection) {
  const owner = hostContext[movesState].store.owner;
  const item = create(ui.MovePreviewItemSchema, { kind: "thread", id });

  const facts = await transaction(hostContext[movesState].store, (sql) =>
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
    await hostContext[movesState].store.query<{ id: string; name: string }>(
      `SELECT id, name FROM projects WHERE id=$1::uuid`,
      [facts.main.project_id],
    )
  )[0];

  item.projectId = project?.id ?? "";
  item.projectName = project?.name ?? "";

  const counts = (
    await hostContext[movesState].store.query<{
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

export async function movesPreviewBot(hostContext: ComputerMoves, id: string, inspection?: link.MoveInspection) {
  const owner = hostContext[movesState].store.owner;
  const item = create(ui.MovePreviewItemSchema, { kind: "bot", id });

  const bot = (
    await hostContext[movesState].store.query<{
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
  item.blocked = await transaction(hostContext[movesState].store, (sql) => botBlocker(sql, owner, id));
  item.moves.push("Conversation and handoff notes");

  if (bot.routines) item.moves.push(bot.routines === 1 ? "1 routine" : `${bot.routines} routines`);

  if (bot.reminders) item.moves.push(bot.reminders === 1 ? "1 reminder" : `${bot.reminders} reminders`);
  const rows = botRowsJson((await exportBot(hostContext[movesState].store, id, "")).rowsJson);

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
export async function movesConfiguration(hostContext: ComputerMoves, target: string) {
  const shared = (
    await hostContext[movesState].store
      .query<{ key: string }>(
        `SELECT key FROM computer_shared_items WHERE owner_user_id=$1::uuid AND shared ORDER BY key`,
        [hostContext[movesState].store.owner],
      )
      .catch(() => [])
  ).map((r) => sharedLabel(r.key));

  const instances = await hostContext[movesState].store
    .query<{ label: string; harness: string; id: string }>(
      `SELECT label, harness, id FROM provider_instances p WHERE NOT EXISTS
      (SELECT 1 FROM computer_shared_items s WHERE s.owner_user_id=$1::uuid AND s.shared AND s.key = 'instance:' || p.harness || ':' || p.id) ORDER BY label`,
      [hostContext[movesState].store.owner],
    )
    .catch(() => []);

  const accounts = await hostContext[movesState].store.query<{ name: string; connector_type: string }>(
    `SELECT name, connector_type FROM connector_accounts WHERE owner_user_id=$1::uuid ORDER BY name`,
    [hostContext[movesState].store.owner],
  );

  const servers = await hostContext[movesState].store.query<{ name: string }>(
    `SELECT name FROM bot_mcp_servers WHERE owner_user_id=$1::uuid ORDER BY name`,
    [hostContext[movesState].store.owner],
  );

  const schedules =
    (
      await hostContext[movesState].store.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM schedules s JOIN projects p ON p.id = s.project_id WHERE p.owner_user_id=$1::uuid AND s.target='new_thread' AND s.status IN ('active','paused')`,
        [hostContext[movesState].store.owner],
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

export interface MovesPreviewMethods {
  preview(request: ui.MovePreviewRequest): Promise<ui.MovePreview>;
}

export const movesPreviewMethods: MovesPreviewMethods = {
  // ------------------------------------------------------------------ UI: preview, start, list

  async preview(this: ComputerMoves, request: ui.MovePreviewRequest): Promise<ui.MovePreview> {
    const target = request.nodeId;
    const unavailable = await this[movesState].host.unavailable(target);

    const preview = create(ui.MovePreviewSchema, {
      nodeId: target,
      name: await this[movesState].host.name(target),
      unavailable,
    });

    const refs = request.everything
      ? await movesEverything(this)
      : request.items.map((i) => ({ kind: i.kind, id: splitId(i.id).id }));

    if (request.items.some((i) => splitId(i.id).node))
      throw new ConnectError("Open it on its own computer to move it", Code.InvalidArgument);
    const inspection = unavailable ? undefined : await movesInspect(this, target, refs).catch(() => undefined);

    for (const ref of refs)
      preview.items.push(
        ref.kind === "bot"
          ? await movesPreviewBot(this, ref.id, inspection)
          : await movesPreviewThread(this, ref.id, inspection),
      );

    if (request.everything) Object.assign(preview, await movesConfiguration(this, target));

    return preview;
  },
};

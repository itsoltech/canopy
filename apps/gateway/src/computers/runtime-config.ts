import { create } from "@bufbuild/protobuf";
import { computerLink as link } from "@canopy/contracts";
import { CONFIG_SYNC } from "@canopy/domain/computers";
import { Code, ConnectError } from "@connectrpc/connect";
import { watchConfig } from "../config-sync/stream.ts";
import { configGroup } from "../config-sync/group.ts";
import type { ConfigRow } from "../config-sync/persistence.ts";
import { linkedMessage } from "./remote.ts";
import { computersState, type Connection } from "./runtime-context.ts";
import type { LinkedComputers } from "./runtime.ts";

export function configAllowed(host: LinkedComputers, node: string, connection?: Connection) {
  const state = host[computersState];

  return (
    !!host.config &&
    !state.stopped &&
    host.hello().capabilities.includes(CONFIG_SYNC) &&
    [...(state.active.get(node) ?? [])].some(
      (c) =>
        (!connection || c === connection) &&
        c.ready &&
        c.protocol &&
        c.configReady &&
        c.capabilities?.has(CONFIG_SYNC) &&
        c.remote &&
        !c.remote.closed,
    )
  );
}

export function stopConfig(host: LinkedComputers, node: string) {
  host[computersState].configWatching.get(node)?.abort();

  for (const controller of host[computersState].configServing.get(node) ?? []) controller.abort();
}

export async function exchangeConfigSharing(host: LinkedComputers, node: string, connection: Connection) {
  if (
    !host.config ||
    !connection.protocol ||
    !connection.capabilities?.has(CONFIG_SYNC) ||
    !host.hello().capabilities.includes(CONFIG_SYNC)
  )
    return;
  const peer = await host.store.peer(node);

  if (peer)
    connection.send({
      body: {
        case: "configSharing",
        value: { enabled: peer.share_config, revision: BigInt(peer.share_config_revision) },
      },
    });
}

export async function receiveConfigSharing(
  host: LinkedComputers,
  node: string,
  connection: Connection,
  sharing: link.ConfigSharing,
) {
  if (
    !host.config ||
    !connection.protocol ||
    !connection.capabilities?.has(CONFIG_SYNC) ||
    !host.hello().capabilities.includes(CONFIG_SYNC)
  )
    throw new ConnectError("Configuration sharing needs an update on both computers", Code.FailedPrecondition);
  await host.store.query(
    `UPDATE computer_peers SET peer_share_config=$3,peer_share_config_revision=$4::bigint
    WHERE owner_user_id=$1::uuid AND node_id=$2 AND peer_share_config_revision<=$4::bigint`,
    [host.store.owner, node, sharing.enabled, sharing.revision.toString()],
  );
  const peer = await host.store.peer(node);
  connection.configReceived = true;

  for (const c of host[computersState].active.get(node) ?? []) {
    if (c === connection || !peer?.share_config || !peer.peer_share_config)
      c.configReady = !!peer?.share_config && peer.peer_share_config;
  }

  if (!configAllowed(host, node)) stopConfig(host, node);
  await refreshConfigGroup(host);
  syncConfig(host, node);
}

export async function setConfigSharing(host: LinkedComputers, node: string, enabled: boolean) {
  const peer = await host.store.peer(node);

  if (!peer) throw new ConnectError("Computer not found", Code.NotFound);

  // Only this side's choice changes. The partner's refusal can never be overridden here.
  await host.store.query(
    `UPDATE computer_peers SET share_config=$3,share_config_revision=share_config_revision+1
    WHERE owner_user_id=$1::uuid AND node_id=$2`,
    [host.store.owner, node, enabled],
  );

  for (const connection of host[computersState].active.get(node) ?? []) {
    connection.configReady = false;
    await exchangeConfigSharing(host, node, connection);
  }

  stopConfig(host, node);

  // A fresh reciprocal exchange is required after changing the local choice.
  for (const connection of host[computersState].active.get(node) ?? [])
    if (enabled && peer.peer_share_config && connection.configReceived) connection.configReady = true;
  await refreshConfigGroup(host);
  syncConfig(host, node);
}

export async function refreshConfigGroup(host: LinkedComputers) {
  if (!host.config) return [];

  const peers = (await host.store.peers()).filter(
    (p) => p.share_config && p.peer_share_config && p.capabilities.includes(CONFIG_SYNC),
  );

  await host.config.publishComputer(
    host.hello().name,
    peers.map((p) => p.node_id),
  );

  const rows = await host.store.query<ConfigRow>(
    "SELECT * FROM config_items WHERE owner_user_id=$1::uuid AND kind='computer'",
    [host.store.owner],
  );

  const group = configGroup(
    rows,
    host.hello().nodeId,
    peers.map((p) => p.node_id),
  );

  const ids = group.map((p) => p.nodeId);
  await host.store.query(
    `DELETE FROM config_items WHERE owner_user_id=$1::uuid AND kind IN ('computer','worker')
    AND home_node_id<>$2 AND NOT(home_node_id=ANY($3::text[]))`,
    [host.store.owner, host.hello().nodeId, ids],
  );
  // Pruned home records must be included in the next bootstrap after groups rejoin.
  await host.store.query(
    "DELETE FROM config_peer_cursors WHERE owner_user_id=$1::uuid AND NOT(node_id=ANY($2::text[]))",
    [host.store.owner, ids],
  );

  return group;
}

export async function alternativeConfigPath(host: LinkedComputers, node: string) {
  if (!host.config) return "";

  const peers = (await host.store.peers()).filter(
    (p) => p.share_config && p.peer_share_config && p.capabilities.includes(CONFIG_SYNC),
  );

  const rows = await host.store.query<ConfigRow>(
    "SELECT * FROM config_items WHERE owner_user_id=$1::uuid AND kind='computer'",
    [host.store.owner],
  );

  const group = configGroup(
    rows,
    host.hello().nodeId,
    peers.map((p) => p.node_id),
    node,
  );

  if (!group.some((p) => p.nodeId === node)) return "";
  const next = peers.find((p) => p.node_id !== node && group.some((member) => member.nodeId === p.node_id));

  return next?.display_name || next?.name || "";
}

export function syncConfig(host: LinkedComputers, node: string) {
  const state = host[computersState];

  if (!configAllowed(host, node)) {
    stopConfig(host, node);

    return;
  }

  if (!host.config || state.configWatching.has(node)) return;
  const sync = host.config;
  const controller = new AbortController();
  state.configWatching.set(node, controller);
  sync.syncing.set(node, true);

  const task = (async () => {
    try {
      const cursor =
        (
          await host.store.query<{ cursor: string }>(
            "SELECT cursor FROM config_peer_cursors WHERE owner_user_id=$1::uuid AND node_id=$2",
            [host.store.owner, node],
          )
        )[0]?.cursor ?? "";

      let hello = false;

      for await (const message of host.remote(
        node,
        link.ConfigSyncService.method.watchConfig,
        create(link.ConfigCursorSchema, { cursor }),
        controller.signal,
      )) {
        const update = linkedMessage(link.ConfigUpdateSchema, message);

        if (!hello) {
          if (!update.hello || update.items.length || update.checkpoint)
            throw new ConnectError("Configuration stream needs a hello", Code.FailedPrecondition);

          if (Object.values(update.hello.schemas).some((version) => version < 1))
            throw new ConnectError("Invalid configuration schema version", Code.InvalidArgument);
          hello = true;
          continue;
        }

        if (update.hello) throw new ConnectError("Configuration hello repeated", Code.InvalidArgument);
        await sync.receive(node, update, () => configAllowed(host, node) && !controller.signal.aborted);

        if (update.checkpoint) sync.syncing.set(node, false);
      }
    } catch {
      // The next heartbeat retries from the last transactionally stored checkpoint.
    } finally {
      if (state.configWatching.get(node) === controller) state.configWatching.delete(node);
      sync.syncing.delete(node);
    }
  })();

  state.tasks.add(task);
  void task.then(
    () => state.tasks.delete(task),
    () => state.tasks.delete(task),
  );
}

export async function* serveConfig(
  host: LinkedComputers,
  node: string,
  connection: Connection,
  request: link.ConfigCursor,
  signal: AbortSignal,
) {
  if (!configAllowed(host, node, connection) || !host.config)
    throw new ConnectError("Configuration sharing is off", Code.FailedPrecondition);
  const peer = await host.store.peer(node);

  if (!peer?.share_config || !peer.peer_share_config)
    throw new ConnectError("Configuration sharing is off", Code.FailedPrecondition);
  const controller = new AbortController();
  const serving = host[computersState].configServing.get(node) ?? new Set();
  serving.add(controller);
  host[computersState].configServing.set(node, serving);

  try {
    yield* watchConfig(
      host.config,
      request.cursor,
      AbortSignal.any([signal, controller.signal]),
      () => configAllowed(host, node, connection) && !controller.signal.aborted,
    );
  } finally {
    serving.delete(controller);

    if (!serving.size) host[computersState].configServing.delete(node);
  }
}

import type { DescMessage, Message } from "@bufbuild/protobuf";
import { CONFIG_SYNC } from "@canopy/domain/computers";
import { Code, ConnectError } from "@connectrpc/connect";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { instanceIds, mapInstanceIds, type InstanceIds } from "../config-sync/aliases.ts";
import type { ComputerStore } from "../computers/store.ts";
import type { GatewayCore } from "../core/core.ts";

/**
 * Instance ids across a link that carries configuration: this computer's ids become global on the way out and
 * the home's own on the way in. A link without Share configuration translates nothing; each side keeps its ids.
 */
export class ConfigIds {
  #ids: Promise<InstanceIds> | undefined;

  private constructor(private readonly store: ComputerStore | undefined) {}

  static async for(core: GatewayCore, node: string) {
    const computers = core.computers;
    const peer = computers?.config ? await computers.store.peer(node) : undefined;

    const carries =
      !!peer &&
      !peer.via_node_id &&
      peer.share_config &&
      peer.peer_share_config &&
      peer.capabilities.includes(CONFIG_SYNC);

    return new ConfigIds(carries ? computers?.store : undefined);
  }

  async map(desc: DescMessage, message: Message, direction: keyof InstanceIds) {
    const store = this.store;

    if (!store || !mapInstanceIds(desc, message, (_harness, id) => id)) return;
    this.#ids ??= store.runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => instanceIds(sql, store.owner)));
    const ids = await this.#ids;
    mapInstanceIds(desc, message, ids[direction]);
  }
}

/** A thread from another computer must name an instance this computer has. */
export async function refuseMissingInstance(core: GatewayCore, harness: string, id: string) {
  if (!id || id === "native" || !core.computers) return;

  const found = await core.computers.store.query("SELECT 1 FROM provider_instances WHERE harness=$1 AND id=$2", [
    harness,
    id,
  ]);

  if (!found.length)
    throw new ConnectError(
      `This instance isn't on “${core.computers.hello().name}”. Choose one of its instances.`,
      Code.FailedPrecondition,
    );
}

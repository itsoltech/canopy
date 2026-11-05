import type { DescMessage, Message } from "@bufbuild/protobuf";
import { CONFIG_SYNC } from "@canopy/domain/computers";
import { Code, ConnectError } from "@connectrpc/connect";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { instanceIds, mapInstanceIds, type InstanceIds } from "../config-sync/aliases.ts";
import type { ComputerStore } from "../computers/store.ts";
import type { GatewayCore } from "../core/core.ts";
import { mapProjectIds, projectIds, type ProjectIds } from "../config-sync/project-aliases.ts";
import { mapProxyIds, proxyIds } from "../config-sync/proxy-aliases.ts";

/**
 * Instance ids across a link that carries configuration: this computer's ids become global on the way out and
 * the home's own on the way in. A link without Share configuration translates nothing; each side keeps its ids.
 */
export class ConfigIds {
  #ids: Promise<InstanceIds> | undefined;
  #projects: Promise<ProjectIds> | undefined;
  #proxies: Promise<Effect.Success<ReturnType<typeof proxyIds>>> | undefined;

  private constructor(private readonly store: ComputerStore | undefined) {}

  static async for(core: GatewayCore, node: string) {
    return new ConfigIds((await ConfigIds.carries(core, node)) ? core.computers?.store : undefined);
  }

  /** A direct link with Share configuration on both sides and both computers able to sync it. */
  static async carries(core: GatewayCore, node: string) {
    const computers = core.computers;
    const peer = computers?.config ? await computers.store.peer(node) : undefined;

    return (
      !!peer &&
      !peer.via_node_id &&
      peer.share_config &&
      peer.peer_share_config &&
      peer.capabilities.includes(CONFIG_SYNC)
    );
  }

  async map(desc: DescMessage, message: Message, direction: keyof InstanceIds, request = false) {
    const store = this.store;

    if (!store) return;

    if (mapInstanceIds(desc, message, (_harness, id) => id)) {
      this.#ids ??= store.runtime.runPromise(
        Effect.flatMap(SqlClient.SqlClient, (sql) => instanceIds(sql, store.owner)),
      );
      const ids = await this.#ids;
      mapInstanceIds(desc, message, ids[direction]);
    }

    const projects = await this.projects();
    mapProjectIds(desc, message, (id) => (projects.known.has(id.split("~")[0]!) ? projects[direction](id) : id));
    mapProxyIds(desc, message, await this.proxies(), direction, request);
  }

  async proxies() {
    const store = this.store;

    if (!store)
      return {
        local: new Set<string>(),
        known: new Set<string>(),
        toLocal: (id: string) => id,
        toGlobal: (id: string) => id,
      };
    this.#proxies ??= store.runtime.runPromise(
      Effect.flatMap(SqlClient.SqlClient, (sql) => proxyIds(sql, store.owner)),
    );

    return this.#proxies;
  }

  async projects(): Promise<ProjectIds> {
    const store = this.store;

    if (!store)
      return {
        known: new Set<string>(),
        local: new Set<string>(),
        toGlobal: (id: string) => id,
        toLocal: (id: string) => id,
      };
    this.#projects ??= store.runtime.runPromise(
      Effect.flatMap(SqlClient.SqlClient, (sql) => projectIds(sql, store.owner)),
    );

    return this.#projects;
  }
}

/** This computer's project ids for overview aggregation; domain foreign keys stay local. */
export async function localProjectIds(core: GatewayCore) {
  const store = core.computers?.store;

  if (!store) return new Set<string>();

  return (await store.runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => projectIds(sql, store.owner))))
    .local;
}

/** A thread from another computer must name an instance this computer has. */
export async function refuseMissingInstance(core: GatewayCore, harness: string, id: string) {
  if (!id || id === "native" || !core.computers) return;

  const found = await core.computers.store.query(
    "SELECT 1 FROM provider_instances WHERE harness=$1 AND id=$2 AND (created_by=$3::uuid OR built_in)",
    [harness, id, core.computers.store.owner],
  );

  if (!found.length)
    throw new ConnectError(
      `This instance isn't on “${core.computers.hello().name}”. Choose one of its instances.`,
      Code.FailedPrecondition,
    );
}

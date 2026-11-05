import { create } from "@bufbuild/protobuf";

import { Code, ConnectError, type ConnectRouter } from "@connectrpc/connect";

import { computerLink as link } from "@canopy/contracts";

import { MOVE_ITEMS, RELAY } from "@canopy/domain/computers";

import { ThreadMirror } from "./mirror.ts";

import { Redirects } from "./redirects.ts";

import { ComputerMoves } from "./moves.ts";

import { ComputerRelay } from "./relay.ts";

import { BotMirror } from "./bot-mirror.ts";

import { Routes } from "./routes.ts";

import { computerGuard, computersState, LinkedComputersState, type Options } from "./runtime-context.ts";
import { computersAccept } from "./runtime-frames.ts";
import { computersEmit, computersMirrorsMethods, type ComputersMirrorsMethods } from "./runtime-mirrors.ts";
import { computersMovable, computersPresenceMethods, type ComputersPresenceMethods } from "./runtime-presence.ts";
import { computersRemoteMethods, type ComputersRemoteMethods } from "./runtime-remote.ts";
import { linkHandler, remoteCertificate, type LinkIdentity } from "./transport.ts";
import { requireDesktopRole } from "../role.ts";
import { fetchConfigBlob } from "./runtime-blobs.ts";
import { ConfigSync } from "../config-sync/engine.ts";

export { computerGuard, type ComputerChange } from "./runtime-context.ts";

export class LinkedComputers {
  declare hello: ComputersPresenceMethods["hello"];
  declare start: ComputersPresenceMethods["start"];
  declare snapshot: ComputersPresenceMethods["snapshot"];
  declare createPairing: ComputersPresenceMethods["createPairing"];
  declare pair: ComputersPresenceMethods["pair"];
  declare manage: ComputersPresenceMethods["manage"];
  declare subscribe: ComputersMirrorsMethods["subscribe"];
  declare capabilities: ComputersRemoteMethods["capabilities"];
  declare reachable: ComputersRemoteMethods["reachable"];
  declare canCall: ComputersRemoteMethods["canCall"];
  declare computer: ComputersRemoteMethods["computer"];
  declare resolve: ComputersRemoteMethods["resolve"];
  declare remote: ComputersRemoteMethods["remote"];
  declare unavailable: ComputersRemoteMethods["unavailable"];
  declare announce: ComputersRemoteMethods["announce"];
  declare close: ComputersRemoteMethods["close"];

  readonly [computersState] = new LinkedComputersState();

  readonly mirror: ThreadMirror;

  readonly botMirror: BotMirror;

  readonly config: ConfigSync | undefined;

  readonly relay: ComputerRelay;

  readonly redirects: Redirects;

  readonly moves: ComputerMoves | undefined;

  constructor(readonly options: Options) {
    requireDesktopRole(options.network.role);

    if (options.core) requireDesktopRole(options.core.role);
    this[computersState].routes = new Routes(options.store);
    options.network.mount("link", linkHandler(this.routes));
    this.mirror = new ThreadMirror(options.store);
    this.botMirror = new BotMirror(options.store);
    this.config = options.shared ? new ConfigSync(options.store, options.shared, () => this.hello().nodeId) : undefined;

    if (this.config) this.config.fetchBlob = (nodeId, hash) => fetchConfigBlob(this, nodeId, hash);
    this.relay = new ComputerRelay(options.store, {
      self: () => this[computersState].identity.node_id,
      enabled: (nodeId) => this.hello().capabilities.includes(RELAY) && this.capabilities(nodeId).includes(RELAY),
      send: (nodeId, catalog) => {
        for (const c of this[computersState].active.get(nodeId) ?? [])
          if (c.ready && c.protocol && c.capabilities?.has(RELAY))
            c.send({ body: { case: "relayCatalog", value: catalog } });
      },
      changed: (nodeId, removed) => computersEmit(this, nodeId, removed),
    });
    this.redirects = new Redirects(options.store, () => this[computersState].identity.node_id);
    this.moves =
      options.core && options.serve
        ? new ComputerMoves(options.store, {
            core: options.core,
            redirects: this.redirects,
            ...(options.moveHook && { hook: options.moveHook }),
            self: () => ({ nodeId: this[computersState].identity.node_id, name: this[computersState].identity.name }),
            name: async (nodeId) => {
              const p = await this.store.computer(nodeId);

              return p?.display_name || p?.name || "the other computer";
            },
            ready: (nodeId) => computersMovable(this, nodeId),
            unavailable: async (nodeId) => {
              if (!(await this.store.peer(nodeId))) return "Moves work only between directly linked computers.";

              if (!this.reachable().includes(nodeId)) return (await this.unavailable(nodeId)).rawMessage;

              return computersMovable(this, nodeId)
                ? ""
                : `${(await this.store.peer(nodeId))?.display_name || "The other computer"} needs an update to receive moves.`;
            },
            call: (nodeId, method, request, signal) => this.remote(nodeId, method, request, signal),
            broadcast: (items) => {
              for (const set of this[computersState].active.values())
                for (const c of set)
                  if (c.ready && c.protocol && c.capabilities?.has(MOVE_ITEMS))
                    c.send({ body: { case: "moved", value: { items } } });
            },
          })
        : undefined;
  }

  get store() {
    return this.options.store;
  }

  get identity(): LinkIdentity {
    return this[computersState].identity;
  }

  /** Where linked computers reach this one (network access). */
  get addresses() {
    return this.options.network.origins();
  }

  routes = (router: ConnectRouter) =>
    router.service(link.ComputerLinkService, {
      pair: async (request, context) =>
        computerGuard(async () => {
          if (!request.hello || request.hello.nodeId === this[computersState].identity.node_id)
            throw new ConnectError("Choose another computer", Code.InvalidArgument);
          await this.store.pair(
            request.secret,
            request.hello,
            context.values.get(remoteCertificate),
            request.shareConfig ?? true,
          );
          void this[computersState].lan?.refresh().catch(() => {});

          for (const c of this[computersState].active.get(request.hello.nodeId) ?? []) c.close();
          this[computersState].retry.delete(request.hello.nodeId);

          return create(link.PairResponseSchema, {
            hello: this.hello(),
            shareConfig: (await this.store.peer(request.hello.nodeId))!.share_config,
          });
        }),
      connect: (request, context) => computersAccept(this, request, context),
    });
}

for (const methods of [computersPresenceMethods, computersMirrorsMethods, computersRemoteMethods]) {
  const descriptors = Object.getOwnPropertyDescriptors(methods);

  for (const descriptor of Object.values(descriptors)) descriptor.enumerable = false;
  Object.defineProperties(LinkedComputers.prototype, descriptors);
}

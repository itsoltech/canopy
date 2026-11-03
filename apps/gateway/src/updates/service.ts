import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type ConnectRouter, type HandlerContext } from "@connectrpc/connect";
import { update } from "@open-agents/contracts";
import { MIN_WORKER_LINK_PROTOCOL, UPDATE_PROTOCOL, WORKER_LINK_PROTOCOL, workerLinkCompatible } from "@open-agents/domain/release/protocol";
import { AsyncChannel } from "@open-agents/transport";
import type { ReleaseMirror } from "@open-agents/updater";

export interface UpdateServiceOptions {
  version: string;
  authenticate(credential: string): Promise<string | undefined>;
  hello(workerId: string, hello: update.CheckRequest): Promise<void>;
  command(workerId: string, hello: update.CheckRequest): Promise<update.UpdateCommand | undefined>;
  report(workerId: string, report: update.ReportRequest): Promise<void>;
  mirror: ReleaseMirror;
  authIntervalMs?: number;
}
export class GatewayUpdateService {
  readonly connections = new Map<string, { channel: AsyncChannel<update.UpdateEvent>; hello: update.CheckRequest }>();
  #epoch = 0;
  #healthy = true;
  constructor(readonly options: UpdateServiceOptions) {}
  verdict(hello?: update.CheckRequest): update.CheckResponse {
    const compatible = hello && workerLinkCompatible(hello.minWorkerLinkProtocol, hello.workerLinkProtocol);
    return create(update.CheckResponseSchema, { healthy: this.#healthy, version: this.options.version, minWorkerLinkProtocol: MIN_WORKER_LINK_PROTOCOL,
      workerLinkProtocol: WORKER_LINK_PROTOCOL, updateProtocol: UPDATE_PROTOCOL,
      ...(hello && { compatibility: compatible ? "compatible" : "update_required", reason: compatible ? "" :
        `WorkerLink ${hello.minWorkerLinkProtocol}..${hello.workerLinkProtocol}; gateway accepts ${MIN_WORKER_LINK_PROTOCOL}..${WORKER_LINK_PROTOCOL}. Update through UpdateService.` }) });
  }
  async #authenticate(workerId: string, ctx: HandlerContext): Promise<string> {
    const credential = /^Bearer\s+(\S+)$/i.exec(ctx.requestHeader.get("authorization") ?? "")?.[1];
    if (!credential || credential.length > 512 || !workerId) throw new ConnectError("Worker credential required", Code.Unauthenticated);
    if (await this.options.authenticate(credential) !== workerId) throw new ConnectError("Invalid or revoked worker credential", Code.Unauthenticated);
    return credential;
  }
  #validate(hello: update.CheckRequest): void {
    if (hello.version.length > 128 || hello.installKind.length > 40 || hello.os.length > 40 || hello.arch.length > 40) {
      throw new ConnectError("Invalid update identity", Code.InvalidArgument);
    }
  }
  routes = (router: ConnectRouter) => router.service(update.UpdateService, {
    check: (request, ctx) => unary(async () => {
      if (!ctx.requestHeader.has("authorization")) return this.verdict();
      await this.#authenticate(request.workerId, ctx);
      this.#validate(request);
      await this.options.hello(request.workerId, request);
      return this.verdict(request);
    }),
    watch: (request, ctx) => streaming(this.#watch(request, ctx)),
    report: (request, ctx) => unary(async () => {
      await this.#authenticate(request.workerId, ctx);
      // Future progress states remain transport-compatible with frozen v1 servers.
      if (request.reason.length > 2000 || request.commandId.length > 100 || request.version.length > 128 ||
        !request.state || request.state.length > 80) throw new ConnectError("Invalid update report", Code.InvalidArgument);
      await this.options.report(request.workerId, request);
      return create(update.ReportResponseSchema);
    }),
    fetchArtifact: (request, ctx) => streaming(this.#fetch(request, ctx)),
  });
  async *#watch(hello: update.CheckRequest, ctx: HandlerContext): AsyncIterable<update.UpdateEvent> {
    const epoch = this.#epoch;
    const credential = await this.#authenticate(hello.workerId, ctx);
    this.#validate(hello);
    await this.options.hello(hello.workerId, hello);
    if (epoch !== this.#epoch || ctx.signal.aborted) throw new ConnectError("Worker credentials changed; reconnect", Code.Unauthenticated);
    const channel = new AsyncChannel<update.UpdateEvent>();
    const connection = { channel, hello };
    this.connections.get(hello.workerId)?.channel.close();
    this.connections.set(hello.workerId, connection);
    channel.push(create(update.UpdateEventSchema, { gateway: this.verdict(hello) }));
    // Release lookup may need the internet; the compatibility verdict never waits for it.
    void this.options.command(hello.workerId, hello).then((command) => {
      if (command && this.connections.get(hello.workerId) === connection && epoch === this.#epoch) this.push(hello.workerId, command);
    }).catch(() => {});
    const abort = () => channel.close();
    ctx.signal.addEventListener("abort", abort, { once: true });
    let checking = false;
    const heartbeat = setInterval(() => {
      if (checking) return;
      checking = true;
      void (async () => {
        if (await this.options.authenticate(credential) !== hello.workerId) { channel.close(new ConnectError("Worker credential revoked", Code.Unauthenticated)); return; }
        channel.push(create(update.UpdateEventSchema, { gateway: this.verdict(hello) }));
      })().catch(() => channel.close(new ConnectError("Update channel unavailable", Code.Unavailable))).finally(() => checking = false);
    }, this.options.authIntervalMs ?? 15_000);
    try { yield* channel; }
    finally {
      clearInterval(heartbeat); ctx.signal.removeEventListener("abort", abort);
      if (this.connections.get(hello.workerId) === connection) this.connections.delete(hello.workerId);
    }
  }
  async *#fetch(request: update.FetchArtifactRequest, ctx: HandlerContext): AsyncIterable<update.ArtifactChunk> {
    const credential = await this.#authenticate(request.workerId, ctx);
    if (request.version !== this.options.version || !["linux", "darwin", "windows"].includes(request.os) || !["x64", "arm64"].includes(request.arch)) {
      throw new ConnectError("Mirror serves only the gateway's own worker release", Code.FailedPrecondition);
    }
    let path: string;
    try { path = await this.options.mirror.artifact(request.os, request.arch); }
    catch { throw new ConnectError("Verified gateway mirror is unavailable; retry after the gateway can reach its release source", Code.Unavailable); }
    // Recheck after a potentially slow upstream download.
    if (await this.options.authenticate(credential) !== request.workerId) throw new ConnectError("Worker credential revoked", Code.Unauthenticated);
    for await (const data of Bun.file(path).stream()) {
      ctx.signal.throwIfAborted();
      yield create(update.ArtifactChunkSchema, { data });
    }
  }
  push(workerId: string, command: update.UpdateCommand): void {
    const connection = this.connections.get(workerId);
    connection?.channel.push(create(update.UpdateEventSchema, { gateway: this.verdict(connection.hello), command }));
  }
  disconnect(workerId: string): void { this.#epoch++; this.connections.get(workerId)?.channel.close(); this.connections.delete(workerId); }
  close(): void {
    this.#healthy = false;
    for (const connection of this.connections.values()) connection.channel.close();
    this.connections.clear();
  }
}

function serviceError(error: unknown): never {
  const failure = error instanceof ConnectError ? error : new ConnectError("Update service unavailable", Code.Unavailable);
  throw failure;
}
async function unary<A>(run: () => Promise<A>): Promise<A> {
  try { return await run(); } catch (error) { return serviceError(error); }
}
async function* streaming<A>(values: AsyncIterable<A>): AsyncIterable<A> {
  try { yield* values; } catch (error) { serviceError(error); }
}

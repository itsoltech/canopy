import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type ConnectRouter, type HandlerContext } from "@connectrpc/connect";
import { ui } from "@canopy/contracts";
import { AsyncChannel } from "@canopy/transport";
import { mobileGuard, type MobileDevices } from "../core/mobile-devices.ts";
import { DesktopUpdateStore } from "./store.ts";

const bearer = (ctx: HandlerContext) =>
  /^Bearer\s+(\S+)$/i.exec(ctx.requestHeader.get("authorization") ?? "")?.[1] ?? "";

/** A desktop app's report about itself: bounded text, its own version and channel, a known phase. */
export function validDesktopState(state: ui.DesktopUpdateState, hello: ui.DesktopHello) {
  if (
    state.reason.length > 1000 ||
    state.disabledReason.length > 500 ||
    state.availableVersion.length > 128 ||
    state.targetVersion.length > 128 ||
    state.version !== hello.version ||
    state.channel !== hello.channel ||
    !Number.isFinite(state.progress) ||
    state.progress < 0 ||
    state.progress > 100 ||
    !["idle", "queued", "checking", "downloading", "waiting_idle", "restarting", "failed", "succeeded"].includes(
      state.phase,
    )
  )
    throw new ConnectError("Invalid desktop state", Code.InvalidArgument);
}

/** A desktop app's hello: its version, a release channel and a worker id of bounded size. */
export function validDesktopHello(hello: ui.DesktopHello) {
  if (
    hello.version.length > 128 ||
    !["stable", "beta", "nightly"].includes(hello.channel) ||
    hello.workerId.length > 100
  )
    throw new ConnectError("Invalid desktop hello", Code.InvalidArgument);
}

export const busy = (phase: string) =>
  ["queued", "checking", "downloading", "waiting_idle", "restarting"].includes(phase);

type Session = {
  id: string;
  deviceId: string;
  hello: ui.DesktopHello;
  confirmed: boolean;
  disabledReason?: string;
  channel: AsyncChannel<ui.DesktopControlEvent>;
};

export class DesktopControl {
  readonly sessions = new Map<string, Session>();
  private queue = Promise.resolve();
  constructor(
    readonly store: DesktopUpdateStore,
    readonly mobile: MobileDevices,
    readonly publish: (state: ui.DesktopUpdateState) => void,
    readonly authenticateWorker: (token: string) => Promise<string | undefined>,
  ) {}

  private serialize<A>(run: () => Promise<A>): Promise<A> {
    const result = this.queue.then(run);
    this.queue = result.then(
      () => {},
      () => {},
    );

    return result;
  }
  private async identity(ctx: HandlerContext) {
    const identity = await this.mobile.authenticate(bearer(ctx));

    if (identity?.clientKind !== "desktop") throw new ConnectError("Paired desktop required", Code.Unauthenticated);

    return identity;
  }
  routes(router: ConnectRouter) {
    router.service(ui.DesktopControlService, {
      watch: (hello, ctx) => this.watch(hello, ctx),
      report: (report, ctx) =>
        mobileGuard(async () => {
          const identity = await this.identity(ctx);
          await this.serialize(() => this.report(identity.deviceId, report));

          return create(ui.DesktopAckSchema);
        }),
    });
    router.service(ui.DesktopWorkerService, {
      confirm: (proof, ctx) =>
        mobileGuard(async () => {
          const workerId = await this.authenticateWorker(bearer(ctx));
          const session = this.sessions.get(proof.deviceId);

          if (!workerId || !session || session.id !== proof.sessionId || session.hello.workerId !== workerId)
            throw new ConnectError("Desktop worker proof required", Code.PermissionDenied);
          await this.serialize(async () => {
            if (!(await this.store.bind(workerId, proof.deviceId)))
              throw new ConnectError("Owned desktop worker required", Code.PermissionDenied);
            session.confirmed = true;
            const row = (await this.store.list()).find((r) => r.workerId === workerId);
            session.channel.push(
              create(ui.DesktopControlEventSchema, {
                sessionId: session.id,
                confirmed: true,
                ...(row?.command.requestId && { command: row.command }),
              }),
            );
          });

          return create(ui.DesktopAckSchema);
        }),
    });
  }
  async *watch(hello: ui.DesktopHello, ctx: HandlerContext) {
    const identity = await this.identity(ctx);

    validDesktopHello(hello);
    const channel = new AsyncChannel<ui.DesktopControlEvent>();
    const session: Session = { id: crypto.randomUUID(), deviceId: identity.deviceId, hello, channel, confirmed: false };
    this.sessions.get(identity.deviceId)?.channel.close();
    this.sessions.set(identity.deviceId, session);
    const controller = new AbortController();
    const release = this.mobile.track(identity.deviceId, controller);
    const stop = () => channel.close();
    ctx.signal.addEventListener("abort", stop, { once: true });
    controller.signal.addEventListener("abort", stop, { once: true });

    const timer = setInterval(() => {
      void this.identity(ctx).then(
        () =>
          channel.push(
            create(ui.DesktopControlEventSchema, {
              sessionId: session.id,
              confirmed: session.confirmed,
            }),
          ),
        () => channel.close(),
      );
    }, 10_000);

    try {
      await this.identity(ctx);
      channel.push(create(ui.DesktopControlEventSchema, { sessionId: session.id }));
      yield* channel;
    } finally {
      clearInterval(timer);
      release();
      ctx.signal.removeEventListener("abort", stop);

      if (this.sessions.get(identity.deviceId) === session) {
        this.sessions.delete(identity.deviceId);
        const row = (await this.store.list()).find((r) => r.deviceId === identity.deviceId);

        if (row) this.publish({ ...row.state, connected: false, disabledReason: "Desktop app is offline." });
      }
    }
  }
  async states() {
    return (await this.store.list()).map((row) => {
      const session = this.sessions.get(row.deviceId);
      const connected = !!session?.confirmed && !session.channel.closed;

      return {
        ...row.state,
        workerId: row.workerId,
        connected,
        disabledReason: !connected
          ? "Desktop app is offline."
          : !session.hello.remoteUpdate
            ? "Update this desktop app manually to enable remote updates."
            : (session.disabledReason ?? row.state.disabledReason),
      };
    });
  }
  async manage(request: ui.ManageUpdatesRequest) {
    return this.serialize(async () => {
      const row = (await this.store.list()).find((r) => r.workerId === request.workerId);

      if (!row) throw new ConnectError("Pair this desktop app to enable remote updates.", Code.FailedPrecondition);
      const session = this.sessions.get(row.deviceId);

      if (!session?.confirmed || session.channel.closed)
        throw new ConnectError("Desktop app is offline.", Code.FailedPrecondition);

      const disabledReason = session.disabledReason ?? row.state.disabledReason;

      if (!session.hello.remoteUpdate || disabledReason)
        throw new ConnectError(
          disabledReason || "Update this desktop app manually to enable remote updates.",
          Code.FailedPrecondition,
        );

      if (request.allowDowngrade) throw new ConnectError("Remote downgrade is forbidden", Code.InvalidArgument);
      let command = row.command;

      if (request.force) {
        if (!command.requestId || request.desktopRequestId !== command.requestId || row.state.phase !== "waiting_idle")
          throw new ConnectError("Force must match the waiting update request", Code.FailedPrecondition);
        command = { ...command, force: true };
      } else if (!busy(row.state.phase)) {
        command = create(ui.DesktopUpdateCommandSchema, { requestId: crypto.randomUUID() });
      } else return;

      const state = {
        ...row.state,
        requestId: command.requestId,
        revision: request.force ? row.state.revision : 0,
        phase: request.force ? row.state.phase : "queued",
        targetVersion: request.force ? row.state.targetVersion : "",
        reason: "",
      };

      const saved = await this.store.save(
        row.workerId,
        row.deviceId,
        state,
        command,
        request.force ? "desktop.update.force" : "desktop.update.request",
      );

      if (!saved || this.sessions.get(row.deviceId) !== session || session.channel.closed)
        throw new ConnectError("Desktop disconnected; reconnect before requesting an update.", Code.FailedPrecondition);
      session.channel.push(create(ui.DesktopControlEventSchema, { sessionId: session.id, confirmed: true, command }));
      this.publish(state);
    });
  }
  private async report(deviceId: string, report: ui.DesktopReport) {
    const session = this.sessions.get(deviceId);
    const state = report.state;

    if (!session?.confirmed || session.id !== report.sessionId || !state || state.workerId !== session.hello.workerId)
      throw new ConnectError("Desktop session not confirmed", Code.FailedPrecondition);

    validDesktopState(state, session.hello);
    session.disabledReason = state.disabledReason;
    const row = (await this.store.list()).find((r) => r.deviceId === deviceId);

    if (row?.command.requestId && !state.requestId) return;

    if (!row || (state.requestId && state.requestId !== row.command.requestId)) return;

    if (state.requestId && state.revision <= row.state.revision && state.requestId === row.state.requestId) return;
    const value = { ...state, connected: true };

    const outcome =
      state.requestId &&
      ["failed", "succeeded"].includes(state.phase) &&
      (state.phase !== row.state.phase || state.requestId !== row.state.requestId);

    if (await this.store.save(row.workerId, deviceId, value, undefined, outcome ? "desktop.update.outcome" : undefined))
      this.publish(value);
  }
  close() {
    for (const session of this.sessions.values()) session.channel.close();
  }
}

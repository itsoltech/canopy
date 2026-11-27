import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type ConnectRouter, type HandlerContext } from "@connectrpc/connect";
import { ui } from "@canopy/contracts";
import { AsyncChannel } from "@canopy/transport";
import { mobileGuard, type MobileDevices } from "../core/mobile-devices.ts";
import { DesktopUpdateStore } from "./store.ts";
import { currentRemoteUpdate } from "@canopy/domain/release/remote-update-state";
import { versionAhead } from "../updates/versions.ts";

const CHECK_THROTTLE_MS = 10_000;

/** A release some computer found on a channel; others on it check their own feeds once for it. */
export type FoundRelease = { channel: string; version: string };

const bearer = (ctx: HandlerContext) =>
  /^Bearer\s+(\S+)$/i.exec(ctx.requestHeader.get("authorization") ?? "")?.[1] ?? "";

const OFFLINE = "Desktop app is offline. Open Canopy on that computer and reconnect to this gateway.";
const UNSUPPORTED = "This app version does not support remote updates. Update it manually in Settings → App updates.";

/** A desktop app's report about itself: bounded text, its own version and channel, a known phase. */
export function validDesktopState(state: ui.DesktopUpdateState, hello: ui.DesktopHello) {
  if (
    state.reason.length > 1000 ||
    state.disabledReason.length > 500 ||
    state.availableVersion.length > 128 ||
    state.targetVersion.length > 128 ||
    state.updaterVersion.length > 128 ||
    state.updaterError.length > 1000 ||
    (state.updaterCurrent &&
      (state.updaterPhase !== "idle" ||
        state.ready ||
        !!state.updaterVersion ||
        !!state.updaterError ||
        !state.lastCheckedAtMs)) ||
    !Number.isFinite(state.updaterProgress) ||
    state.updaterProgress < 0 ||
    state.updaterProgress > 100 ||
    !Number.isSafeInteger(state.lastCheckedAtMs) ||
    state.lastCheckedAtMs < 0 ||
    !["", "idle", "checking", "downloading", "downloaded", "error", "disabled"].includes(state.updaterPhase) ||
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

/** The newest release this app's own updater reports above its running version, if any. */
function foundRelease(hello: ui.DesktopHello, state: ui.DesktopUpdateState): FoundRelease | undefined {
  const version = [state.availableVersion, state.updaterVersion]
    .filter((v) => versionAhead(v, hello.version))
    .reduce((newest, v) => (!newest || versionAhead(v, newest) ? v : newest), "");

  return version ? { channel: hello.channel, version } : undefined;
}

/** A previously paired device can return with an old request in its local journal. */
function withoutPreviousRequest(state: ui.DesktopUpdateState): ui.DesktopUpdateState {
  return {
    ...state,
    requestId: "",
    revision: 0,
    phase: "idle",
    reason: "",
    progress: 0,
    targetVersion: "",
    availableVersion: state.updaterVersion || (state.updaterCurrent ? state.version : ""),
  };
}

/** A found release this app should hear about: same channel, newer than all it knows, not announced to it yet. */
function releaseNews(release: FoundRelease, session: Session, state: ui.DesktopUpdateState) {
  return (
    release.channel === session.hello.channel &&
    release.version !== session.nudged &&
    [session.hello.version, state.availableVersion].filter(Boolean).every((v) => versionAhead(release.version, v))
  );
}

type Session = {
  id: string;
  deviceId: string;
  hello: ui.DesktopHello;
  confirmed: boolean;
  disabledReason?: string;
  channel: AsyncChannel<ui.DesktopControlEvent>;
  checkedAt?: number;
  nudged?: string;
};

export class DesktopControl {
  readonly sessions = new Map<string, Session>();
  private queue = Promise.resolve();
  private readonly announced = new Set<string>();
  constructor(
    readonly store: DesktopUpdateStore,
    readonly mobile: MobileDevices,
    readonly publish: (state: ui.DesktopUpdateState) => void,
    readonly authenticateWorker: (token: string) => Promise<string | undefined>,
    readonly found: (release: FoundRelease) => void = () => {},
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
          const found = await this.serialize(() => this.report(identity.deviceId, report));

          // Announce each release once, outside the queue: the fan-out serializes its own reads.
          if (found && !this.announced.has(`${found.channel}@${found.version}`)) {
            this.announced.add(`${found.channel}@${found.version}`);
            this.found(found);
          }

          return create(ui.DesktopAckSchema);
        }),
    });
    router.service(ui.DesktopWorkerService, {
      confirm: (proof, ctx) =>
        mobileGuard(async () => {
          const workerId = await this.authenticateWorker(bearer(ctx));

          await this.serialize(async () => {
            const session = this.sessions.get(proof.deviceId);

            if (
              !workerId ||
              !session ||
              session.channel.closed ||
              session.id !== proof.sessionId ||
              session.hello.workerId !== workerId
            )
              throw new ConnectError("Desktop worker proof required", Code.PermissionDenied);

            const previous = (await this.store.list()).find((row) => row.workerId === workerId);
            const incumbent = previous && this.sessions.get(previous.deviceId);

            // A new pairing can replace the recorded device once its control stream is gone.
            const replace =
              previous && !(incumbent?.confirmed && !incumbent.channel.closed) ? previous.deviceId : undefined;

            const current = () => this.sessions.get(proof.deviceId) === session && !session.channel.closed;
            const command = await this.store.bind(workerId, proof.deviceId, current, replace);

            if (!command) throw new ConnectError("Owned desktop worker required", Code.PermissionDenied);
            session.confirmed = true;
            session.channel.push(
              create(ui.DesktopControlEventSchema, {
                sessionId: session.id,
                confirmed: true,
                ...(command.requestId && { command }),
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

        if (row) this.publish({ ...row.state, connected: false, disabledReason: OFFLINE });
      }
    }
  }
  async states() {
    return this.serialize(async () =>
      Promise.all(
        (await this.store.list()).map(async (row) => {
          const session = this.sessions.get(row.deviceId);
          const connected = !!session?.confirmed && !session.channel.closed;

          const state = currentRemoteUpdate({
            ...row.state,
            version: connected ? session.hello.version : row.state.version,
          });

          if (state.phase !== row.state.phase)
            await this.store.save(row.workerId, row.deviceId, state, undefined, "desktop.update.outcome");

          return {
            ...state,
            workerId: row.workerId,
            connected,
            disabledReason: !connected
              ? OFFLINE
              : !session.hello.remoteUpdate
                ? UNSUPPORTED
                : (session.disabledReason ?? row.state.disabledReason),
          };
        }),
      ),
    );
  }
  async manage(request: ui.ManageUpdatesRequest) {
    return this.serialize(async () => {
      const row = (await this.store.list()).find((r) => r.workerId === request.workerId);

      if (!row) throw new ConnectError("Pair this desktop app to enable remote updates.", Code.FailedPrecondition);
      const session = this.sessions.get(row.deviceId);

      if (request.action === "desktop_dismiss") {
        if (
          !request.desktopRequestId ||
          row.state.phase !== "failed" ||
          request.desktopRequestId !== row.state.requestId
        )
          throw new ConnectError("Choose the current failed update to dismiss.", Code.FailedPrecondition);
        const command = { ...row.command, dismiss: true, force: false };
        const state = { ...row.state, phase: "idle", reason: "" };

        if (!(await this.store.save(row.workerId, row.deviceId, state, command, "desktop.update.dismiss")))
          throw new ConnectError("Pair this desktop app again to dismiss its update.", Code.PermissionDenied);
        session?.channel.push(
          create(ui.DesktopControlEventSchema, { sessionId: session.id, confirmed: true, command }),
        );
        this.publish(state);

        return;
      }

      if (!session?.confirmed || session.channel.closed) throw new ConnectError(OFFLINE, Code.FailedPrecondition);

      const disabledReason = session.disabledReason ?? row.state.disabledReason;

      if (!session.hello.remoteUpdate || disabledReason)
        throw new ConnectError(disabledReason || UNSUPPORTED, Code.FailedPrecondition);

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
    let state = report.state;

    if (!session?.confirmed || session.id !== report.sessionId || !state || state.workerId !== session.hello.workerId)
      throw new ConnectError("Desktop session not confirmed", Code.FailedPrecondition);

    validDesktopState(state, session.hello);
    session.disabledReason = state.disabledReason;
    const row = (await this.store.list()).find((r) => r.deviceId === deviceId);
    const requestId = row?.command.requestId;

    if (!row || (requestId && state.requestId !== requestId)) return foundRelease(session.hello, state);

    if (!requestId && state.requestId) state = withoutPreviousRequest(state);

    const found = foundRelease(session.hello, state);

    if (state.requestId && state.revision <= row.state.revision && state.requestId === row.state.requestId)
      return found;

    // The row keeps the requested update; the updater's live state is for linked computers (local.ts).
    const value = {
      ...currentRemoteUpdate(state),
      ...(row.command.dismiss && state.requestId === row.state.requestId && { phase: "idle", reason: "" }),
      connected: true,
      updaterPhase: "",
      updaterVersion: "",
      updaterProgress: 0,
      updaterError: "",
    };

    const outcome =
      state.requestId &&
      ["failed", "succeeded"].includes(value.phase) &&
      (value.phase !== row.state.phase || state.requestId !== row.state.requestId);

    if (await this.store.save(row.workerId, deviceId, value, undefined, outcome ? "desktop.update.outcome" : undefined))
      this.publish(value);

    return found;
  }
  /**
   * Ask connected desktop apps to check their own feeds: the owner's Check now, or a release another computer
   * found on their channel (each app is asked once per such release). Installs nothing and grants no version.
   */
  async check(release?: FoundRelease) {
    await this.serialize(async () => {
      const rows = await this.store.list();

      for (const session of this.sessions.values()) {
        const row = rows.find((r) => r.deviceId === session.deviceId);

        if (
          !row ||
          !session.confirmed ||
          session.channel.closed ||
          !session.hello.remoteUpdate ||
          (session.disabledReason ?? row.state.disabledReason) ||
          busy(row.state.phase) ||
          Date.now() - (session.checkedAt ?? 0) < CHECK_THROTTLE_MS ||
          (release && !releaseNews(release, session, row.state))
        )
          continue;
        session.checkedAt = Date.now();

        if (release) session.nudged = release.version;
        session.channel.push(
          create(ui.DesktopControlEventSchema, { sessionId: session.id, confirmed: true, command: { check: true } }),
        );
      }
    });
  }
  close() {
    for (const session of this.sessions.values()) session.channel.close();
  }
}

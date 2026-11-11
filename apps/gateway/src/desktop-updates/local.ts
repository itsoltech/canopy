import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { ui } from "@canopy/contracts";
import { AsyncChannel } from "@canopy/transport";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import type { CoreRuntime } from "../core/core.ts";
import { busy, validDesktopHello, validDesktopState } from "./control.ts";

type Session = { id: string; hello: ui.DesktopHello; channel: AsyncChannel<ui.DesktopControlEvent> };

const CHECK_THROTTLE_MS = 10_000;
const CHECK_TIMEOUT_MS = 30_000;

/** Who asked: a directly linked computer of this owner (its node id and name). */
export type AppUpdateOrigin = { nodeId: string; name: string; deviceId?: string };

/**
 * Local mode: the desktop app's own control channel to its bundled gateway (docs/updates.md, "Połączone komputery").
 * Linked computers ask for an app update through it; the app runs it with its own updater, channel and settings,
 * waits for idle and restarts. State lives in the app's journal; this process keeps the last report in memory.
 */
export class LocalAppControl {
  private session: Session | undefined;
  private remoteUpdate = false;
  private state = create(ui.DesktopUpdateStateSchema, { phase: "idle" });
  private command = create(ui.DesktopUpdateCommandSchema);
  private queue = Promise.resolve();
  private lastCheckRequested = 0;
  private checking: { promise: Promise<void>; finish: () => void; after: number } | undefined;
  constructor(
    readonly runtime: CoreRuntime,
    readonly owner: string,
    private readonly changed: () => void = () => {},
  ) {}

  get supportsUpdates() {
    return this.remoteUpdate;
  }

  private serialize<A>(run: () => Promise<A>): Promise<A> {
    const result = this.queue.then(run);
    this.queue = result.then(
      () => {},
      () => {},
    );

    return result;
  }

  async *watch(hello: ui.DesktopHello, signal: AbortSignal) {
    validDesktopHello(hello);
    const channel = new AsyncChannel<ui.DesktopControlEvent>();
    const session: Session = { id: crypto.randomUUID(), hello, channel };
    this.checking?.finish();
    this.session?.channel.close();
    this.session = session;
    this.remoteUpdate = hello.remoteUpdate;
    this.changed();
    const stop = () => channel.close();
    signal.addEventListener("abort", stop, { once: true });

    try {
      // A command sent before a reconnect is sent again; the app ignores a request id it already ran.
      channel.push(
        create(ui.DesktopControlEventSchema, {
          sessionId: session.id,
          confirmed: true,
          ...(this.command.requestId && busy(this.state.phase) && { command: this.command }),
        }),
      );
      yield* channel;
    } finally {
      signal.removeEventListener("abort", stop);

      if (this.session === session) {
        this.checking?.finish();
        this.session = undefined;
        this.changed();
      }
    }
  }

  report(report: ui.DesktopReport) {
    return this.serialize(async () => {
      const session = this.session;
      const state = report.state;

      if (!session || session.id !== report.sessionId || !state || state.workerId !== session.hello.workerId)
        throw new ConnectError("App control session not open", Code.FailedPrecondition);
      validDesktopState(state, session.hello);

      // Until the app takes up a new request, its reports (older or no request) don't replace the queued state.
      if (this.command.requestId && state.requestId !== this.command.requestId) return;
      this.state = create(ui.DesktopUpdateStateSchema, { ...state, connected: true });
      this.changed();

      if (
        this.checking &&
        state.lastCheckedAtMs > this.checking.after &&
        !["checking", "downloading"].includes(state.updaterPhase)
      )
        this.checking.finish();

      if (state.requestId && ["failed", "succeeded"].includes(state.phase)) await this.outcome(state);
    });
  }

  /** The app as linked computers see it: offline until its control channel is open. */
  snapshot(): ui.DesktopUpdateState {
    const open = !!this.session && !this.session.channel.closed;

    return create(ui.DesktopUpdateStateSchema, {
      ...this.state,
      connected: open,
      disabledReason: !open
        ? "The Canopy app isn't connected to its gateway."
        : !this.supportsUpdates
          ? "Update this computer from its own window once to enable remote updates."
          : this.state.disabledReason,
    });
  }

  /** A linked computer asks for an app update. The app checks its own feed; nothing here grants a version. */
  request(origin: AppUpdateOrigin) {
    return this.serialize(async () => {
      const session = this.session;
      const state = this.snapshot();

      if (!session || session.channel.closed || state.disabledReason)
        throw new ConnectError(state.disabledReason, Code.FailedPrecondition);

      if (busy(state.phase)) return;
      this.command = create(ui.DesktopUpdateCommandSchema, {
        requestId: crypto.randomUUID(),
        requestedBy: origin.name,
      });
      this.state = create(ui.DesktopUpdateStateSchema, {
        ...this.state,
        requestId: this.command.requestId,
        revision: 0,
        phase: "queued",
        targetVersion: "",
        reason: "",
      });
      await this.audit("desktop.update.request", {
        node: origin.nodeId,
        device: origin.deviceId ?? "",
        requestId: this.command.requestId,
        version: state.availableVersion,
      });
      session.channel.push(
        create(ui.DesktopControlEventSchema, { sessionId: session.id, confirmed: true, command: this.command }),
      );
      this.changed();
    });
  }

  /** Owner UI or a linked computer asks for a real check. Coalesce presses; never install or replay a check. */
  check(): Promise<void> {
    if (this.checking) return this.checking.promise;
    const session = this.session;

    if (
      !session ||
      session.channel.closed ||
      busy(this.state.phase) ||
      ["checking", "downloading", "disabled"].includes(this.state.updaterPhase) ||
      Date.now() - this.lastCheckRequested < CHECK_THROTTLE_MS
    )
      return Promise.resolve();
    this.lastCheckRequested = Date.now();

    // Older apps already understand check-only commands, but cannot acknowledge completion.
    // Keep their last reported status and unknown timestamp instead of waiting for a field they never send.
    if (session.hello.updateChecks) {
      const { promise, resolve } = Promise.withResolvers<void>();
      const timer = setTimeout(() => this.checking?.finish(), CHECK_TIMEOUT_MS);
      this.checking = {
        promise,
        after: this.state.lastCheckedAtMs,
        finish: () => {
          clearTimeout(timer);
          this.checking = undefined;
          resolve();
        },
      };
    }

    session.channel.push(
      create(ui.DesktopControlEventSchema, { sessionId: session.id, confirmed: true, command: { check: true } }),
    );

    return this.checking?.promise ?? Promise.resolve();
  }

  close() {
    this.checking?.finish();
    this.session?.channel.close();
  }

  private async outcome(state: ui.DesktopUpdateState) {
    // The app reports its last outcome again after every restart; it enters the audit log once.
    await this.audit("desktop.update.outcome", {
      requestId: state.requestId,
      version: state.targetVersion || state.availableVersion,
      outcome: state.phase,
      reason: state.reason,
    });
  }

  private audit(action: string, details: Record<string, string>) {
    const owner = this.owner;

    return this.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO audit_log (id, actor_user_id, action, target_type, target_id, details)
        SELECT ${Bun.randomUUIDv7()}::uuid, ${owner}::uuid, ${action}, 'computer', NULL, ${JSON.stringify(details)}::jsonb
        WHERE NOT EXISTS (SELECT 1 FROM audit_log WHERE actor_user_id = ${owner}::uuid AND action = ${action}
          AND details->>'requestId' = ${details["requestId"] ?? ""})`;
      }),
    );
  }
}

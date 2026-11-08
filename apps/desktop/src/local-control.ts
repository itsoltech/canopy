import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { create, fromJsonString } from "@bufbuild/protobuf";
import type { Client } from "@connectrpc/connect";
import { ui } from "@canopy/contracts";
import { Schema } from "effect";

/** The local worker's id for the hello, once the local worker is enrolled. */
export function localControlTarget(directory: string, client: () => Client<typeof ui.GatewayService>) {
  const path = join(directory, "local-worker", "worker.json");

  if (!existsSync(path)) return undefined;

  const worker = Schema.decodeUnknownSync(Schema.Struct({ worker_id: Schema.String }))(
    JSON.parse(readFileSync(path, "utf8")),
  );

  return { client: client(), workerId: worker.worker_id };
}

/**
 * Controller only, local mode: the app's control channel to its own bundled gateway (service token on loopback).
 * Linked computers ask for app updates through it; the app runs them like remote updates (docs/updates.md).
 */
export class LocalDesktopControl {
  private stopping = new AbortController();
  private sessionId = "";
  private watching: { version: string; channel: string; abort: AbortController } | undefined;
  private state = create(ui.DesktopUpdateStateSchema, { phase: "idle" });
  constructor(
    private readonly api: Client<typeof ui.GatewayService>,
    private readonly workerId: string,
    private readonly command: (command: ui.DesktopUpdateCommand) => void,
  ) {}
  async report(json: string) {
    this.state = fromJsonString(ui.DesktopUpdateStateSchema, json);

    // The hello names the app's version and channel; a changed channel opens a new session.
    if (this.watching && (this.watching.version !== this.state.version || this.watching.channel !== this.state.channel))
      this.watching.abort.abort();
    else if (this.sessionId)
      await this.api.reportAppControl(
        { sessionId: this.sessionId, state: { ...this.state, workerId: this.workerId } },
        { timeoutMs: 3000 },
      );
  }
  async run() {
    while (!this.stopping.signal.aborted) {
      const { version, channel } = this.state;
      const abort = new AbortController();
      this.watching = { version, channel, abort };

      try {
        if (version)
          for await (const event of this.api.watchAppControl(
            { workerId: this.workerId, version, channel, remoteUpdate: true, updateChecks: true },
            { signal: AbortSignal.any([this.stopping.signal, abort.signal]), timeoutMs: 0 },
          )) {
            this.sessionId = event.sessionId;
            await this.api.reportAppControl(
              { sessionId: this.sessionId, state: { ...this.state, workerId: this.workerId } },
              { timeoutMs: 3000 },
            );

            if (event.command) this.command(event.command);
          }
      } catch {
        /* The gateway restarts with the app or is starting; reconnect. A request id never runs twice. */
      }

      this.sessionId = "";
      this.watching = undefined;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  stop() {
    this.stopping.abort();
  }
}

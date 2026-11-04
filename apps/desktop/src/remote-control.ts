import { readFileSync } from "node:fs";
import { join } from "node:path";
import { create, fromJsonString } from "@bufbuild/protobuf";
import { createClient } from "@connectrpc/connect";
import { ui } from "@canopy/contracts";
import { routedPinnedTransport } from "@canopy/transport";
import { Schema } from "effect";
import type { DesktopClientCredential } from "./remote-client.ts";

const WorkerIdentity = Schema.Struct({ worker_id: Schema.String, credential: Schema.String });

/** Controller only. The renderer and Electron main never receive the worker credential. */
export class RemoteDesktopControl {
  private stopping = new AbortController();
  private sessionId = "";
  private confirmed = false;
  private state = create(ui.DesktopUpdateStateSchema, { phase: "idle" });
  private api;
  private worker;
  private workerId: string;
  constructor(
    client: DesktopClientCredential,
    directory: string,
    private readonly command: (command: ui.DesktopUpdateCommand) => void,
  ) {
    const identity = Schema.decodeUnknownSync(WorkerIdentity)(
      JSON.parse(readFileSync(join(directory, "worker.json"), "utf8")),
    );

    this.workerId = identity.worker_id;
    this.api = createClient(ui.DesktopControlService, routedPinnedTransport(client, client.token).transport);
    this.worker = createClient(ui.DesktopWorkerService, routedPinnedTransport(client, identity.credential).transport);
    this.deviceId = client.deviceId;
  }
  private readonly deviceId: string;
  async report(json: string) {
    this.state = fromJsonString(ui.DesktopUpdateStateSchema, json);

    if (this.confirmed)
      await this.api.report(
        { sessionId: this.sessionId, state: { ...this.state, workerId: this.workerId } },
        { timeoutMs: 3000 },
      );
  }
  async run() {
    while (!this.stopping.signal.aborted) {
      try {
        if (!this.state.version) {
          await this.pause();
          continue;
        }

        for await (const event of this.api.watch(
          { workerId: this.workerId, version: this.state.version, channel: this.state.channel, remoteUpdate: true },
          { signal: this.stopping.signal },
        )) {
          this.sessionId = event.sessionId;

          if (!event.confirmed) {
            await this.worker.confirm({ deviceId: this.deviceId, sessionId: event.sessionId }, { timeoutMs: 3000 });
          } else {
            this.confirmed = true;
            await this.api.report(
              { sessionId: this.sessionId, state: { ...this.state, workerId: this.workerId } },
              { timeoutMs: 3000 },
            );

            if (event.command) this.command(event.command);
          }
        }
      } catch {
        /* Reconnect with the same persisted request; never replay a new mutation. */
      }

      this.confirmed = false;
      await this.pause();
    }
  }
  private pause() {
    return new Promise<void>((resolve) => {
      if (this.stopping.signal.aborted) {
        resolve();

        return;
      }

      const done = () => {
        clearTimeout(timer);
        this.stopping.signal.removeEventListener("abort", done);
        resolve();
      };

      const timer = setTimeout(done, 3000);
      this.stopping.signal.addEventListener("abort", done, { once: true });
    });
  }
  stop() {
    this.stopping.abort();
  }
}

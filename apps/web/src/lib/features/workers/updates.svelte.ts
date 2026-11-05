import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { requestJson } from "#lib/shared/http.ts";
import { decode, encode } from "#lib/shared/wire.ts";
import type { Tone } from "#lib/shared/ui/tone.ts";

export class UpdatesState {
  snapshot = $state<ui.UpdatesSnapshot>();
  error = $state("");
  pending = $state("");
  #loading = false;
  async reload(): Promise<void> {
    if (this.#loading || this.pending) return;
    this.#loading = true;

    try {
      this.snapshot = decode(ui.UpdatesSnapshotSchema, await requestJson("GET", "/api/updates"));
      this.error = "";
    } catch (error) {
      this.error = error instanceof Error ? error.message : "Could not load updates";
    } finally {
      this.#loading = false;
    }
  }
  async manage(input: MessageInitShape<typeof ui.ManageUpdatesRequestSchema>): Promise<void> {
    if (this.pending) return;
    this.pending = input.workerId || input.action || "update";
    this.error = "";

    try {
      this.snapshot = decode(
        ui.UpdatesSnapshotSchema,
        await requestJson(
          "POST",
          "/api/updates",
          encode(ui.ManageUpdatesRequestSchema, create(ui.ManageUpdatesRequestSchema, input)),
          150_000,
        ),
      );
    } catch (error) {
      this.error = error instanceof Error ? error.message : "Update action failed";
    } finally {
      this.pending = "";
    }
  }
}

export const updateBusy = (state: string) => ["queued", "waiting_idle", "downloading", "restarting"].includes(state);

export const updateStateLabel = (state: string, compatible: boolean) =>
  ({
    queued: "Queued",
    waiting_idle: "Waiting for idle",
    downloading: "Updating",
    restarting: "Restarting",
    failed: "Failed",
    succeeded: "Up to date",
    managed_externally: "Managed externally",
    ahead: "Newer than gateway",
  })[state] ?? (compatible ? "Compatible" : "Update required");

/** One badge tone per update state, like settled statuses (status.ts): up to date is emerald everywhere. */
export const updateTone = ({ failed = false, busy = false, current = false }): Tone =>
  failed ? "rose" : busy ? "amber" : current ? "emerald" : "neutral";

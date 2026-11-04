import { getContext, setContext } from "svelte";
import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { requestJson } from "#lib/shared/http.ts";
import { decode } from "#lib/shared/wire.ts";

/**
 * Configuration shared with linked computers (docs/linked-computers.md, stage 4): which items are shared,
 * who changed them last and the open questions after offline edits. Live through OverviewUpdate.shared_config.
 */
export class SharedConfigState {
  snapshot = $state.raw(create(ui.SharedConfigSnapshotSchema));
  #items = $derived(new Map(this.snapshot.items.map((i) => [i.key, i])));

  item(key: string): ui.SharedConfigItem | undefined {
    return this.#items.get(key);
  }
  shared(key: string): boolean {
    return this.#items.get(key)?.shared ?? false;
  }
  conflicts(key?: string): ui.SharedConfigConflict[] {
    return key === undefined ? this.snapshot.conflicts : this.snapshot.conflicts.filter((c) => c.key === key);
  }

  apply(update: ui.OverviewUpdate): void {
    if (update.change.case === "sharedConfig") this.snapshot = update.change.value;
  }
  async reload(): Promise<void> {
    this.snapshot = decode(ui.SharedConfigSnapshotSchema, await requestJson("GET", "/api/computers/shared"));
  }
  async manage(action: "share" | "unshare" | "keep_local" | "keep_remote", key: string, nodeId = ""): Promise<void> {
    this.snapshot = decode(
      ui.SharedConfigSnapshotSchema,
      await requestJson("PUT", "/api/computers/shared", { action, key, nodeId }),
    );
  }
}

const KEY = Symbol("shared-config");
export const provideSharedConfig = (state: SharedConfigState) => setContext(KEY, state);
export const useSharedConfig = () => getContext<SharedConfigState>(KEY);

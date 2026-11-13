import { untrack } from "svelte";
import { rememberThreadScroll, type ThreadScrollPosition } from "@canopy/domain/thread-scroll";
import { devicePreferences as device } from "../settings/device-preferences.svelte.ts";
import type { ComposerCompaction } from "./components/composer-compaction.ts";
import type { FeedRow } from "./feed.ts";
import type { WorkFolds } from "./work-folds.svelte.ts";

export function threadScrollMemory(id: string, compaction: ComposerCompaction, publish: (compact: boolean) => void) {
  let prepared = $state(false);

  return {
    get prepared() {
      return prepared;
    },
    get initial() {
      return untrack(() => device.view.threadScroll.find((entry) => entry.threadId === id)?.position);
    },
    prepare(rows: readonly FeedRow[], folds: WorkFolds, historyOpen: boolean): boolean {
      folds.keepFlat(rows);

      if (prepared) return historyOpen;
      const initial = this.initial;
      const key = initial?.mode === "anchor" ? initial.key : undefined;

      if (key?.startsWith("history:") && !historyOpen) return true;
      const ownKey = key?.replace(/^history:[^:]+:/, "");

      if (ownKey && folds.revealKey(ownKey)) return historyOpen;
      const group = rows.find((row) => row.kind === "work-group" && row.items.includes(ownKey ?? ""));
      const groupKey = group?.key.replace(/^history:[^:]+:/, "");

      if (groupKey && !folds.groups.has(groupKey)) {
        folds.toggleGroup(groupKey, true);

        return historyOpen;
      }

      prepared = true;

      return historyOpen;
    },
    save(position: ThreadScrollPosition) {
      device.setView({ threadScroll: rememberThreadScroll(device.view.threadScroll, id, position) });
    },
    restored(following: boolean) {
      if (!following) {
        compaction.compact = true;
        publish(true);
      }
    },
  };
}

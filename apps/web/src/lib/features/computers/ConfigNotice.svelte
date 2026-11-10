<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import Button from "#lib/shared/ui/Button.svelte";
  import { timestampFromDate } from "@bufbuild/protobuf/wkt";
  import { formatTime } from "#lib/shared/format.ts";
  import { configFieldLabel, configItemValue, configNoticeValue } from "./config-copy.ts";
  import { useSettings } from "#lib/features/settings/settings-state.svelte.ts";

  let {
    notice,
    busy = false,
    named = true,
    library = false,
    onaction,
    class: className,
  }: {
    notice: ui.ConfigNotice;
    busy?: boolean;
    /** Off where the item is already the page's subject. */
    named?: boolean;
    library?: boolean;
    onaction: (id: string, action: "restore" | "dismiss") => void;
    class?: ClassValue;
  } = $props();

  const settings = useSettings();

  const time = $derived(
    formatTime(timestampFromDate(new Date(Number(notice.changedAtMs))), settings?.user.timezone || undefined),
  );

  const item = $derived(notice.kind !== "settings");
  const removed = $derived(item && notice.reason === "deleted" && notice.field === "deleted");
  const choice = $derived(notice.reason === "choice");

  const message = $derived(
    choice
      ? `${notice.nodeName} has a different value. Choose which to keep.`
      : removed
        ? `Deleted on ${notice.nodeName} at ${time}.`
        : notice.reason === "merged"
          ? `Merged with ${notice.nodeName}.`
          : notice.reason === "resurrected"
            ? `${notice.nodeName} changed it after it was deleted here.`
            : `${notice.nodeName} also changed this at ${time}.`,
  );

  const title = $derived(
    removed
      ? notice.itemName || "Deleted item"
      : item && named && notice.itemName
        ? `${notice.itemName}: ${configFieldLabel(notice.field, notice.kind)}`
        : configFieldLabel(notice.field, notice.kind),
  );

  const value = $derived(
    removed ? "" : item ? configItemValue(notice.field, notice.value) : configNoticeValue(notice.value),
  );
</script>

<div
  class={["settings-row flex min-w-0 flex-col items-start justify-between gap-3 px-4 py-3.5 sm:flex-row", className]}
>
  <div class="grid min-w-0 flex-1">
    <p class="text-base/6 font-medium break-words text-zinc-950 sm:text-sm/6 dark:text-white">{title}</p>
    <p class="text-sm/5 text-pretty break-words text-zinc-500 dark:text-zinc-400">{message}</p>
    {#if value}<p class="mt-1 line-clamp-3 text-sm/5 break-words text-zinc-600 dark:text-zinc-300">{value}</p>{/if}
  </div>
  <div class="flex max-w-full shrink-0 flex-wrap gap-2">
    <Button size="sm" disabled={busy} onclick={() => onaction(notice.id, "restore")}
      >{choice
        ? "Use the other’s"
        : notice.reason === "resurrected"
          ? "Delete"
          : library && removed
            ? "Keep"
            : "Restore"}</Button
    >
    <Button size="sm" variant="ghost" disabled={busy} onclick={() => onaction(notice.id, "dismiss")}
      >{choice ? "Keep this computer’s" : library && removed ? "Accept deletion" : "Dismiss"}</Button
    >
  </div>
</div>

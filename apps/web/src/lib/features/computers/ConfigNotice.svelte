<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import Button from "#lib/shared/ui/Button.svelte";
  import { timestampFromDate } from "@bufbuild/protobuf/wkt";
  import { formatTime } from "#lib/shared/format.ts";
  import { configFieldLabel, configNoticeValue } from "./config-copy.ts";
  import { useSettings } from "#lib/features/settings/settings-state.svelte.ts";

  let {
    notice,
    busy = false,
    onaction,
    class: className,
  }: {
    notice: ui.ConfigNotice;
    busy?: boolean;
    onaction: (id: string, action: "restore" | "dismiss") => void;
    class?: ClassValue;
  } = $props();

  const settings = useSettings();

  const message = $derived(
    notice.reason === "merged"
      ? `Merged with ${notice.nodeName}.`
      : notice.reason === "resurrected"
        ? `${notice.nodeName} changed it after it was deleted here.`
        : `${notice.nodeName} also changed this at ${formatTime(timestampFromDate(new Date(Number(notice.changedAtMs))), settings?.user.timezone || undefined)}.`,
  );
</script>

<div
  class={["settings-row flex min-w-0 flex-col items-start justify-between gap-3 px-4 py-3.5 sm:flex-row", className]}
>
  <div class="grid min-w-0 flex-1">
    <p class="text-base/6 font-medium break-words text-zinc-950 sm:text-sm/6 dark:text-white">
      {configFieldLabel(notice.field)}
    </p>
    <p class="text-sm/5 text-pretty break-words text-zinc-500 dark:text-zinc-400">{message}</p>
    <p class="mt-1 line-clamp-3 text-sm/5 break-words text-zinc-600 dark:text-zinc-300">
      {configNoticeValue(notice.value)}
    </p>
  </div>
  <div class="flex shrink-0 gap-2">
    <Button size="sm" disabled={busy} onclick={() => onaction(notice.id, "restore")}
      >{notice.reason === "resurrected" ? "Delete" : "Restore"}</Button
    >
    <Button size="sm" variant="ghost" disabled={busy} onclick={() => onaction(notice.id, "dismiss")}>Dismiss</Button>
  </div>
</div>

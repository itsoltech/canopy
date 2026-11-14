<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import Button from "#lib/shared/ui/Button.svelte";
  import { timestampFromDate } from "@bufbuild/protobuf/wkt";
  import { formatTime } from "#lib/shared/format.ts";
  import { configNotice } from "@canopy/domain/config-notice";
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

  const row = $derived(configNotice(notice, time, { named, library }));
</script>

<div
  class={["settings-row flex min-w-0 flex-col items-start justify-between gap-3 px-4 py-3.5 sm:flex-row", className]}
>
  <div class="grid min-w-0 flex-1">
    <p class="text-base/6 font-medium break-words text-zinc-950 sm:text-sm/6 dark:text-white">{row.title}</p>
    <p class="text-sm/5 text-pretty break-words text-zinc-500 dark:text-zinc-400">{row.message}</p>
    {#if row.value}<p class="mt-1 line-clamp-3 text-sm/5 break-words text-zinc-600 dark:text-zinc-300">
        {row.value}
      </p>{/if}
  </div>
  <div class="flex max-w-full shrink-0 flex-wrap gap-2">
    <Button size="sm" disabled={busy} onclick={() => onaction(notice.id, "restore")}>{row.restore}</Button>
    <Button size="sm" variant="ghost" disabled={busy} onclick={() => onaction(notice.id, "dismiss")}
      >{row.dismiss}</Button
    >
  </div>
</div>

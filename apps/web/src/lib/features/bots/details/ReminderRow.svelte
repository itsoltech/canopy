<script lang="ts">
  import { timestampDate } from "@bufbuild/protobuf/wkt";
  import type { bots } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  let { reminder, busy = false, disabled = false, oncancel, class: className }: { reminder: bots.BotReminder; busy?: boolean; disabled?: boolean; oncancel: () => void; class?: ClassValue } = $props();
</script>

<li class={["flex items-start gap-3", className]}>
  <div class="grid min-w-0 flex-1 gap-1">
    <p class="line-clamp-3 text-pretty text-zinc-800 dark:text-zinc-200">{reminder.prompt}</p>
    {#if reminder.runAt}<p class="text-sm/5 text-zinc-500 tabular-nums sm:text-xs/5 dark:text-zinc-400">{timestampDate(reminder.runAt).toLocaleString('en', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</p>{/if}
  </div>
  <IconButton icon="x-mark" size="sm" label="Cancel reminder" {disabled} loading={busy} onclick={oncancel} />
</li>

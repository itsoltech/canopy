<script lang="ts">
  import { beforeNavigate } from "$app/navigation";
  import { page, updated } from "$app/state";
  import { untrack } from "svelte";
  import { updateNotice, updateState } from "../updates.svelte.ts";
  import Button from "./Button.svelte";
  import { toast } from "./toast.svelte.ts";

  $effect(() => updateNotice.detect(updated.current));

  // A page that did not download offers its own reload (`+error.svelte`); the version may be the same.
  const shown = $derived(updateState.available && page.error?.scope !== "assets");

  $effect(() => {
    if (shown) untrack(() => toast("A new version is available", { tone: "info" }));
  });

  beforeNavigate(({ to, willUnload, cancel }) => {
    if ((updated.current || updateState.available) && !willUnload && to?.url) {
      cancel();
      location.href = to.url.href;
    }
  });
</script>

{#if shown}
  <div
    class="fixed inset-x-0 bottom-4 z-50 flex justify-center px-4 macos:max-h-[max(0px,var(--window-safe-height)-2rem)] macos:overflow-y-auto"
    role="status"
  >
    <div
      class="flex items-center gap-3 rounded-xl bg-white px-4 py-2 text-sm/6 text-zinc-950 shadow-lg ring-1 ring-zinc-950/10 dark:bg-zinc-900 dark:text-white dark:ring-white/10"
    >
      <span>A new version is available —</span>
      <Button size="sm" onclick={() => location.reload()}>Reload</Button>
    </div>
  </div>
{/if}

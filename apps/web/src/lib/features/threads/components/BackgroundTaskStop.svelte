<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import Button from "#lib/shared/ui/Button.svelte";
  import { stopBackgroundTask } from "../api.ts";
  import { useThreadDirectory } from "../thread-directory.ts";

  let { threadId, itemId, class: className }: { threadId: string; itemId: string; class?: ClassValue } = $props();
  let stopping = $state(false);
  const directory = useThreadDirectory();
  let error = $state<string>();

  async function stop() {
    if (stopping) return;
    stopping = true;
    error = undefined;

    try {
      await stopBackgroundTask(threadId, itemId);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "Stopping failed";
      stopping = false;
    }
  }
</script>

<div class={["grid gap-1", className]}>
  <Button size="sm" icon="stop" disabled={directory.readOnly} loading={stopping} onclick={stop}
    >{stopping ? "Stopping…" : "Stop"}</Button
  >
  {#if error}<p role="alert" class="text-xs/5 text-rose-700 dark:text-rose-400">{error}</p>{/if}
</div>

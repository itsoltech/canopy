<script lang="ts">
  import type { CloneProgress } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import { tick } from "svelte";
  import { cloneProgressLabel } from "@canopy/domain/clone-progress";
  import ProgressBar from "#lib/shared/ui/ProgressBar.svelte";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";
  import Button from "#lib/shared/ui/Button.svelte";

  let {
    progress,
    busy,
    worker,
    failed = false,
    capable = true,
    oncancel,
    class: className,
  }: {
    progress: CloneProgress | undefined;
    busy: boolean;
    worker: string;
    failed?: boolean;
    capable?: boolean;
    oncancel?: (() => void) | undefined;
    class?: ClassValue;
  } = $props();

  let open = $state(false);
  let log = $state<HTMLPreElement>();
  const label = $derived(cloneProgressLabel(progress));
  const lines = $derived(progress?.lines.join("\n") || "Waiting for Git…");

  $effect(() => {
    if (failed) open = true;
  });

  $effect(() => {
    void lines;

    if (open)
      void tick().then(() => {
        if (log) log.scrollTop = log.scrollHeight;
      });
  });
</script>

<div class={["min-w-0 space-y-2", className]}>
  <div class="flex min-h-10 items-center gap-3 sm:min-h-8">
    <p
      role="status"
      class="line-clamp-2 min-w-0 flex-1 text-sm/5 text-zinc-700 tabular-nums sm:block sm:truncate sm:text-xs/5 dark:text-zinc-300"
      title={label}
    >
      {label}
    </p>
    {#if busy && oncancel}<Button variant="secondary" size="sm" onclick={oncancel}>Cancel</Button>{/if}
  </div>
  <ProgressBar
    value={progress?.percent}
    label="Clone progress on {worker}"
    class={busy && progress?.percent === undefined ? "t-pulse" : undefined}
  />
  {#if capable}<Disclosure
      bind:open
      summaryClass="min-h-10 items-center text-sm/5 text-zinc-500 sm:min-h-7 sm:text-xs/5 dark:text-zinc-400"
    >
      {#snippet summary()}Show Git log{/snippet}
      <!-- svelte-ignore a11y_no_noninteractive_tabindex (Keyboard users need to focus and scroll the log.) -->
      <pre
        bind:this={log}
        role="region"
        aria-label="Git clone log"
        tabindex="0"
        class="h-32 scroll-stable overflow-auto rounded-md bg-zinc-950/2.5 p-2 font-mono text-xs/5 wrap-anywhere whitespace-pre-wrap text-zinc-700 select-text dark:bg-white/5 dark:text-zinc-300">{lines}</pre>
    </Disclosure>{/if}
</div>

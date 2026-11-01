<script lang="ts">
  import Icon from "./Icon.svelte";
  import { toasts } from "./toast.svelte.ts";

  /**
   * Where `toast()` messages show: a polite live region at the top centre. A toast rises in (motion.css
   * `t-toast`), a success draws its check (`t-success-check`), and it sinks out a little faster.
   */
</script>

<div class="pointer-events-none fixed inset-x-0 top-3 z-50 flex flex-col items-center gap-2 px-4" role="status" aria-live="polite">
  {#each toasts as entry (entry.id)}
    <div
      class="t-toast pointer-events-auto flex items-center gap-2 rounded-full bg-zinc-950 py-1.5 pr-3.5 pl-2.5 text-sm/5 font-medium text-white shadow-lg data-closing:absolute dark:bg-zinc-800 dark:shadow-none dark:ring-1 dark:ring-white/10"
      data-closing={entry.closing || undefined}
    >
      {#if entry.tone === "success"}
        <span class="t-success-check text-emerald-400" aria-hidden="true">
          <svg viewBox="0 0 16 16" fill="none" class="size-4"><path d="M4 8.5l2.5 2.5L12 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" /></svg>
        </span>
      {:else}
        <Icon name={entry.tone === "error" ? "exclamation-circle" : "information-circle"} class={entry.tone === "error" ? "fill-rose-400" : "fill-sky-400"} />
      {/if}
      {entry.text}
    </div>
  {/each}
</div>

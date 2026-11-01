<script lang="ts">
  import type { ClassValue } from "svelte/elements";

  /** Unified diff with added, removed and hunk lines coloured; plain text when it is not a diff. */
  let { diff, label, class: className }: { diff: string; label: string; class?: ClassValue } = $props();

  const lines = $derived(
    diff.replace(/\n$/, "").split("\n").map((text) => ({
      text,
      kind: text.startsWith("+++") || text.startsWith("---") ? "file" : text.startsWith("+") ? "add" : text.startsWith("-") ? "del" : text.startsWith("@@") ? "hunk" : "ctx",
    })),
  );
  const tone: Record<string, string> = {
    add: "bg-emerald-500/10 text-emerald-900 dark:text-emerald-200",
    del: "bg-rose-500/10 text-rose-900 dark:text-rose-200",
    hunk: "text-sky-700 dark:text-sky-400",
    file: "text-zinc-500 dark:text-zinc-400",
    ctx: "text-zinc-700 dark:text-zinc-300",
  };
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div class={["code-surface max-h-[32rem] rounded-lg bg-zinc-950/2.5 py-2 focus-ring dark:bg-white/5", className]} tabindex="0" role="region" aria-label={label}>
  <div class="inline-block min-w-full">
    {#each lines as line, index (index)}
      <div class={["px-3", tone[line.kind]]}>{line.text || " "}</div>
    {/each}
  </div>
</div>

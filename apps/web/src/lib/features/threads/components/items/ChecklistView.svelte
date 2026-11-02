<script lang="ts">
  import Icon from "#lib/shared/ui/Icon.svelte";
  import Markdown from "#lib/shared/ui/markdown/Markdown.svelte";
  import ChecklistSteps from "./ChecklistSteps.svelte";

  /** Plan steps or a todo list with their status (pending | in_progress | completed). Always visible. */
  let { title, text = "", steps }: { title: string; text?: string; steps: readonly { text: string; status: string }[] } = $props();
  const done = $derived(steps.filter((s) => s.status === "completed").length);
</script>

<section class="rounded-xl p-4 ring-1 ring-zinc-950/10 dark:ring-white/10" aria-label={title}>
  <div class="flex items-center justify-between gap-3 text-base/6 sm:text-sm/6">
    <h3 class="flex items-center gap-2 font-medium text-zinc-950 dark:text-white"><Icon name="queue-list" class="fill-zinc-400 dark:fill-zinc-500" />{title}</h3>
    {#if steps.length > 0}<span class="text-sm/5 text-zinc-500 tabular-nums sm:text-xs/5 dark:text-zinc-400">{done} of {steps.length} done</span>{/if}
  </div>
  {#if text}<Markdown {text} class="mt-2" />{/if}
  {#if steps.length > 0}<ChecklistSteps {steps} class="mt-3" />{/if}
</section>

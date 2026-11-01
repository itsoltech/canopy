<script lang="ts">
  import Icon from "#lib/shared/ui/Icon.svelte";
  import Markdown from "#lib/shared/ui/markdown/Markdown.svelte";
  import Spinner from "#lib/shared/ui/Spinner.svelte";

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
  {#if steps.length > 0}
    <ol role="list" class="mt-3 grid gap-1.5 text-base/6 sm:text-sm/6">
      {#each steps as step, index (index)}
        <li class="flex gap-2.5">
          <span class="flex h-lh items-center">
            {#if step.status === "completed"}
              <Icon name="check-circle" class="fill-emerald-600 dark:fill-emerald-400" label="Done" />
            {:else if step.status === "in_progress"}
              <Spinner class="text-sky-600 dark:text-sky-400" /><span class="sr-only">In progress</span>
            {:else}
              <span class="grid size-4 place-items-center"><span class="size-3 rounded-full ring-1 ring-zinc-950/25 ring-inset dark:ring-white/25"></span></span><span class="sr-only">Pending</span>
            {/if}
          </span>
          <span class={step.status === "completed" ? "text-zinc-500 line-through decoration-zinc-400/60 dark:text-zinc-400" : step.status === "in_progress" ? "font-medium text-zinc-950 dark:text-white" : "text-zinc-700 dark:text-zinc-300"}>{step.text}</span>
        </li>
      {/each}
    </ol>
  {/if}
</section>

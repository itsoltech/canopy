<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import Spinner from "#lib/shared/ui/Spinner.svelte";

  /** Steps with their state (pending | in_progress | completed): done ones struck through, the current one bold. */
  let { steps, class: className }: { steps: readonly { text: string; status: string }[]; class?: ClassValue } =
    $props();
</script>

<ol role="list" class={["grid gap-1.5 text-base/6 sm:text-sm/6", className]}>
  {#each steps as step, index (index)}
    <li class="flex gap-2.5">
      <span class="flex h-lh shrink-0 items-center">
        {#if step.status === "completed"}
          <Icon name="check-circle" class="fill-emerald-600 dark:fill-emerald-400" label="Done" />
        {:else if step.status === "in_progress"}
          <Spinner class="text-sky-600 dark:text-sky-400" /><span class="sr-only">In progress</span>
        {:else}
          <span class="grid size-4 place-items-center"
            ><span class="size-3 rounded-full ring-1 ring-zinc-950/25 ring-inset dark:ring-white/25"></span></span
          ><span class="sr-only">Pending</span>
        {/if}
      </span>
      <span
        class={step.status === "completed"
          ? "text-zinc-500 line-through decoration-zinc-400/60 dark:text-zinc-400"
          : step.status === "in_progress"
            ? "font-medium text-zinc-950 dark:text-white"
            : "text-zinc-700 dark:text-zinc-300"}>{step.text}</span
      >
    </li>
  {/each}
</ol>

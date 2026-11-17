<script lang="ts">
  import type { PreparationStep } from "../thread-creation.svelte.ts";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import Spinner from "#lib/shared/ui/Spinner.svelte";

  let {
    steps,
    done = false,
    failed = false,
  }: { steps: readonly PreparationStep[]; done?: boolean; failed?: boolean } = $props();

  const statuses = {
    pending: "Pending",
    running: "In progress",
    completed: "Done",
    skipped: "Skipped",
    failed: "Failed",
  };
</script>

<div role="status" class="text-base/6 sm:text-sm/6">
  <p class="py-1 font-medium text-zinc-700 dark:text-zinc-300">
    {failed ? "Could not start thread" : done ? "Thread prepared" : "Preparing thread…"}
  </p>
  <ol role="list" class="grid gap-1 text-zinc-500 dark:text-zinc-400">
    {#each steps as step (step.step)}
      <li class="flex min-w-0 items-start gap-2">
        <span class="flex h-lh w-4 shrink-0 items-center justify-center" aria-hidden="true">
          {#if step.status === "running"}<Spinner />
          {:else if step.status === "completed"}<Icon name="check" />
          {:else if step.status === "failed"}<Icon name="x-mark" class="text-red-600 dark:text-red-400" />
          {:else if step.status === "skipped"}<Icon name="minus" />
          {:else}<span class="size-2 rounded-full ring-1 ring-current ring-inset"></span>{/if}
        </span>
        <span
          class="min-w-0 flex-1 break-words"
          class:text-zinc-950={step.status === "running"}
          class:dark:text-white={step.status === "running"}
        >
          {step.label}
          {#if step.detail && step.status !== "failed"}<span
              class="block text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">{step.detail}</span
            >{/if}
        </span>
        <span class="w-24 shrink-0 text-right text-sm/6 text-zinc-500 sm:text-xs/6 dark:text-zinc-400"
          >{statuses[step.status]}</span
        >
      </li>
    {/each}
  </ol>
</div>

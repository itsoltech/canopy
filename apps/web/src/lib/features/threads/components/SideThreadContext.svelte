<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import { tooltip } from "#lib/shared/ui/tooltip.ts";

  let {
    main,
    worker,
    project,
    class: className,
  }: { main: ui.Thread; worker: ui.Worker | undefined; project: ui.Project | undefined; class?: ClassValue } = $props();

  const computer = $derived(worker?.name || "the same computer");

  const details = $derived(
    [
      project?.name,
      `Computer: ${computer}`,
      main.cwd && `Directory: ${main.cwd}`,
      main.worktree?.branch && `Branch: ${main.worktree.branch}`,
      "Uses the main thread's workspace, including its worktree.",
    ]
      .filter(Boolean)
      .join("\n"),
  );
</script>

<div class={["grid min-w-0 justify-items-center gap-3", className]}>
  <h1 class="text-3xl font-medium tracking-tight text-balance text-zinc-950 dark:text-white">New side thread</h1>
  <p class="flex max-w-full min-w-0 items-center gap-1.5 text-sm/5 text-zinc-500 dark:text-zinc-400">
    <Icon name="computer-desktop" class="shrink-0" />
    <span class="shrink-0">Same directory on</span>
    <span class="min-w-0 truncate" title={details} {@attach tooltip(details)}>{computer}</span>
  </p>
</div>

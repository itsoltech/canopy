<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import { workerStatus } from "#lib/features/overview/workers.ts";
  import Button from "#lib/shared/ui/Button.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import StatusDot from "#lib/shared/ui/StatusDot.svelte";

  /**
   * One worker in a project's settings: its status and the project's directory there (change, remove),
   * or "Add". Choosing a directory browses the worker, so adding and changing need it online.
   */
  let {
    worker,
    workspaces,
    computer,
    readonly = false,
    onadd,
    onmove,
    onremove,
    class: className,
  }: {
    worker: ui.Worker;
    computer: string;
    readonly?: boolean;
    /** The project's workspaces on this worker. */
    workspaces: readonly ui.Workspace[];
    onadd: () => void;
    onmove: (workspace: ui.Workspace) => void;
    onremove: (workspace: ui.Workspace) => void;
    class?: ClassValue;
  } = $props();
</script>

<div class={["flex items-start gap-3 px-4 py-3.5", className]}>
  <div class="flex h-lh shrink-0 items-center px-1 text-base/6 sm:text-sm/6">
    <StatusDot tone={worker.online ? "emerald" : "neutral"} />
  </div>
  <div class="min-w-0 flex-1">
    <p class="truncate text-base/6 font-medium text-zinc-950 sm:text-sm/6 dark:text-white">{worker.name}</p>
    <p class="text-sm/5 break-words text-zinc-500 dark:text-zinc-400">{computer}</p>
    <p class="text-sm/5 text-pretty text-zinc-500 dark:text-zinc-400">
      {workerStatus(worker)}{workspaces.length === 0 && !worker.online ? " · start it to choose a directory" : ""}
    </p>
    {#if workspaces.length > 0}
      <ul role="list" class="mt-2 grid gap-1">
        {#each workspaces as ws (ws.id)}
          <li class="flex min-w-0 items-center gap-2 text-zinc-700 dark:text-zinc-300">
            <Icon name="folder" class="fill-zinc-400 dark:fill-zinc-500" />
            <code
              class="min-w-0 flex-1 font-mono text-sm/6 break-all sm:truncate sm:text-[0.8125rem]/6"
              title={ws.rootPath}>{ws.rootPath}</code
            >
            {#if !readonly}<IconButton
                icon="pencil-square"
                size="sm"
                label={worker.online ? "Change the directory" : `Start ${worker.name} to change the directory`}
                disabled={!worker.online}
                onclick={() => onmove(ws)}
              />
              <IconButton icon="trash" size="sm" label="Remove from {worker.name}" onclick={() => onremove(ws)} />{/if}
          </li>
        {/each}
      </ul>
    {/if}
  </div>
  {#if workspaces.length === 0 && !readonly}
    <Button size="sm" icon="plus" disabled={!worker.online} onclick={onadd}>Add</Button>
  {/if}
</div>

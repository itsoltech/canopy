<script lang="ts">
  import type { AgentTool } from "@canopy/contracts";
  import type { IconName } from "@canopy/ui/icons";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import Switch from "#lib/shared/ui/Switch.svelte";
  import SettingsCard from "#lib/shared/ui/SettingsCard.svelte";
  import { expand } from "#lib/shared/ui/motion.ts";
  import { workerTool, toolKey, type ToolWorker, type AgentToolActions } from "./agent-tools.svelte.ts";
  import ToolSessionDefaults from "./ToolSessionDefaults.svelte";
  import ToolWorkerRow from "./ToolWorkerRow.svelte";

  let {
    tool,
    name,
    description,
    icon,
    workers,
    actions,
  }: {
    tool: AgentTool;
    name: string;
    description: string;
    icon: IconName;
    workers: ToolWorker[];
    actions: AgentToolActions;
  } = $props();

  const id = $props.id();
  let open = $state(false);
  let saving = $state(false);
  const enabled = $derived(workers.filter(({ worker }) => workerTool(worker, tool)?.enabled).length);
  const mixed = $derived(enabled > 0 && enabled < workers.length);

  const editable = $derived(
    workers.filter(
      ({ worker, readOnly }) => !readOnly && workerTool(worker, tool) && (worker.online || enabled === workers.length),
    ),
  );

  const pending = $derived(saving || workers.some(({ worker }) => Boolean(actions.pending[toolKey(worker.id, tool)])));
  const unavailable = $derived(workers.length - editable.length);

  const installing = $derived(
    workers.filter(({ worker }) => workerTool(worker, tool)?.tool?.install?.state === "running").length,
  );

  const failed = $derived(
    workers.filter(({ worker }) => {
      const info = workerTool(worker, tool)?.tool;

      return actions.errors[toolKey(worker.id, tool)] || (!info?.ready && info?.install?.state === "failed");
    }).length,
  );

  let all = $state(false);

  $effect(() => {
    if (!pending) all = workers.length > 0 && enabled === workers.length;
  });

  async function enableAll(value: boolean) {
    if (pending) return;
    const targets = editable.filter(({ worker }) => workerTool(worker, tool)?.enabled !== value);

    if (!targets.length) {
      all = workers.length > 0 && enabled === workers.length;

      return;
    }

    saving = true;

    try {
      // Bound concurrent installs and retain a separate result for every worker.
      for (let i = 0; i < targets.length; i += 4) {
        if (actions.disposed) break;
        await Promise.all(targets.slice(i, i + 4).map(({ worker }) => actions.enable(worker.id, tool, value)));
      }
    } finally {
      saving = false;
      all = workers.length > 0 && enabled === workers.length;
    }
  }
</script>

<SettingsCard>
  <div class="flex items-center gap-3 px-4 py-4 sm:gap-4 sm:px-5">
    <button
      type="button"
      class="flex min-w-0 flex-1 items-center gap-3 rounded-md text-left focus-ring sm:gap-4"
      aria-expanded={open}
      aria-controls={id}
      onclick={() => (open = !open)}
    >
      <span
        class="flex size-10 shrink-0 items-center justify-center rounded-xl bg-zinc-950/4 text-zinc-600 dark:bg-white/5 dark:text-zinc-300"
        ><Icon name={icon} class="size-5 fill-current" /></span
      >
      <span class="min-w-0 flex-1">
        <span class="block font-semibold text-zinc-950 dark:text-white">{name}</span>
        <span class="mt-0.5 hidden text-sm/5 text-zinc-500 sm:block dark:text-zinc-400">{description}</span>
        <span class="mt-0.5 block text-sm/5 text-zinc-500 tabular-nums dark:text-zinc-400" role="status"
          >{enabled} of {workers.length} enabled{#if installing}
            · {installing} installing{/if}{#if failed}
            · {failed} need attention{/if}</span
        >
      </span>
      <Icon
        name="chevron-right"
        class={[
          "shrink-0 fill-zinc-400 transition-transform duration-(--duration-fast) ease-smooth-out motion-reduce:transition-none",
          open && "rotate-90",
        ]}
      />
    </button>
    <Switch
      name={`all-agent-tool-${tool}`}
      label={`Use ${name} on all workers`}
      description="Enable or disable access on all available workers."
      bind:checked={all}
      indeterminate={mixed}
      disabled={pending || !editable.length}
      onchange={(value) => void enableAll(value)}
    />
  </div>
  {#if open}
    <div {id} transition:expand class="border-t border-zinc-950/5 dark:border-white/8">
      <div
        class="flex items-center justify-between gap-4 bg-zinc-950/2 px-4 py-2 text-sm/5 text-zinc-500 sm:px-5 dark:bg-white/2 dark:text-zinc-400"
      >
        <span>Workers</span><span>Agent access</span>
      </div>
      <div class="divide-y divide-zinc-950/5 dark:divide-white/8">
        {#each workers as entry (entry.worker.id)}<ToolWorkerRow {entry} {tool} {name} {actions} busy={saving} />{/each}
      </div>
      {#if unavailable}<p
          class="border-t border-zinc-950/5 px-4 py-3 text-sm/5 text-zinc-500 sm:px-5 dark:border-white/8 dark:text-zinc-400"
        >
          {unavailable}
          {unavailable === 1 ? "worker is" : "workers are"} unavailable here. Connect workers or open their home computer
          to change access.
        </p>{/if}
      <ToolSessionDefaults {tool} {name} />
    </div>
  {/if}
</SettingsCard>

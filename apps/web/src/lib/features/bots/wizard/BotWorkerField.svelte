<script lang="ts">
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import { instanceKeyOf } from "#lib/features/providers/instances.ts";
  import Field from "#lib/shared/ui/Field.svelte";
  import Select from "#lib/shared/ui/Select.svelte";
  import ButtonLink from "#lib/shared/ui/ButtonLink.svelte";

  let {
    value = $bindable(""),
    instanceId,
    disabled = false,
  }: {
    value?: string;
    instanceId: string;
    disabled?: boolean;
  } = $props();

  const overview = useOverview();

  const options = $derived([
    {
      value: "",
      label: "Automatic",
      description: "Uses the local worker in desktop mode, or else the first online worker that can run the bot.",
    },
    ...overview.ownWorkers
      .filter((w) => w.id === value || w.providerInstances.some((i) => instanceKeyOf(i) === instanceId && i.enabled))
      .map((w) => ({
        value: w.id,
        label: w.name,
        description: w.online ? "Online" : "Offline · messages wait",
      })),
  ]);
</script>

<Field label="Runs on" description="The bot keeps its session on this worker. Messages wait while it is offline.">
  <Select bind:value {options} {disabled} />
  {#if options.length === 1}
    <p class="mt-2 text-sm/6 text-zinc-600 dark:text-zinc-400">
      No worker has this provider instance enabled. Enable it on a worker in provider settings, install its agent CLI
      and sign in. Automatic waits until a worker that can run the bot is online.
    </p>
    <ButtonLink size="sm" variant="ghost" href={`/settings/providers?instance=${encodeURIComponent(instanceId)}`}
      >Open provider settings</ButtonLink
    >
  {:else if value && !overview
      .worker(value)
      ?.providerInstances.some((i) => instanceKeyOf(i) === instanceId && i.enabled)}
    <p class="mt-2 text-sm/6 text-zinc-600 dark:text-zinc-400">
      This worker no longer has this provider instance enabled. Enable it in provider settings or pick another worker.
    </p>
  {/if}
</Field>

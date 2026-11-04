<script lang="ts">
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import { instanceKeyOf } from "#lib/features/providers/instances.ts";
  import Field from "#lib/shared/ui/Field.svelte";
  import Select from "#lib/shared/ui/Select.svelte";

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
    { value: "", label: "Automatic", description: "Choose an online worker when the bot first runs." },
    ...overview.ownWorkers
      .filter((w) => w.id === value || w.providerInstances.some((i) => instanceKeyOf(i) === instanceId && i.enabled))
      .map((w) => ({
        value: w.id,
        label: w.name,
        description: w.online ? "Online" : "Offline · messages will wait",
      })),
  ]);
</script>

<Field
  label="Runs on"
  description="The bot keeps its harness session on this worker. Messages wait while it is offline."
>
  <Select bind:value {options} {disabled} />
</Field>

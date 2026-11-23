<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import { providerLabel } from "#lib/features/threads/labels.ts";
  import { instanceLabel } from "#lib/features/threads/providers.ts";
  import Button from "#lib/shared/ui/Button.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import SearchPicker from "#lib/shared/ui/SearchPicker.svelte";

  let {
    profiles,
    value,
    placeholder,
    disabled,
    onchange,
  }: {
    profiles: ReadonlyMap<string, ui.MemoryReflectionModel>;
    value: string;
    placeholder: string;
    disabled: boolean;
    onchange: (value: string) => void;
  } = $props();

  const overview = useOverview();

  const choices = $derived(
    [...profiles]
      .map(([key, option]) => {
        const worker = overview.ownWorkers.find((worker) => worker.id === option.workerId);
        const id = option.profileId || "native";
        const instance = worker?.providerInstances.find((item) => item.harness === option.provider && item.id === id);

        return {
          key,
          provider: providerLabel(option.provider),
          worker: worker?.name || option.workerName,
          profile: instanceLabel(instance ?? { id, label: "" }),
        };
      })
      .sort(
        (a, b) =>
          a.provider.localeCompare(b.provider) ||
          a.worker.localeCompare(b.worker) ||
          a.profile.localeCompare(b.profile),
      ),
  );

  const selected = $derived(choices.find((item) => item.key === value));
  const summary = $derived(selected ? `${selected.provider} · ${selected.worker} · ${selected.profile}` : placeholder);
  let open = $state(false);

  $effect(() => {
    if (disabled) open = false;
  });
</script>

<div class="w-64 max-w-full">
  <SearchPicker
    bind:open
    label="Provider profile"
    searchLabel="Search profiles"
    placeholder="Search profiles"
    placement="bottom-end"
    items={choices}
    key={(item) => item.key}
    text={(item) => `${item.provider} ${item.worker} ${item.profile}`}
    groupOf={(item) => item.provider}
    {value}
    onselect={(item) => onchange(item.key)}
  >
    {#snippet trigger(props)}
      <Button {...props} {disabled} class="w-full" aria-label={selected ? `Provider profile: ${summary}` : undefined}>
        <span class="min-w-0 flex-1 text-left wrap-anywhere whitespace-normal">{summary}</span>
        <Icon name="chevron-up-down" tone="muted" />
      </Button>
    {/snippet}
    {#snippet option(item, { selected })}
      <div class="flex min-h-6 items-center gap-3 sm:min-h-5 pointer-coarse:min-h-8">
        <span class="min-w-0 flex-1 font-medium wrap-anywhere">{item.worker}</span>
        <span class="max-w-[45%] text-right text-sm/5 wrap-anywhere text-muted sm:text-xs/4">{item.profile}</span>
        <Icon name="check" class={["text-brand-600 dark:text-brand-400", !selected && "invisible"]} />
      </div>
    {/snippet}
    {#snippet empty()}No profiles found{/snippet}
  </SearchPicker>
</div>

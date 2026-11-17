<script lang="ts">
  import DropdownMenu from "#lib/shared/ui/DropdownMenu.svelte";
  import MenuCheckItem from "#lib/shared/ui/MenuCheckItem.svelte";
  import PillButton from "#lib/shared/ui/PillButton.svelte";
  import type { ModelOption } from "./catalog.ts";
  import { supportedServiceTier } from "./service-tier.ts";
  import SpeedIcon from "./SpeedIcon.svelte";

  let {
    option,
    value = $bindable(),
    inherited,
    adaptive = false,
  }: {
    option: ModelOption;
    value?: string | undefined;
    inherited?: string | undefined;
    adaptive?: boolean;
  } = $props();

  const chosen = $derived(supportedServiceTier(option, value));
  const fallback = $derived(supportedServiceTier(option, inherited));

  const label = $derived(
    chosen === "default" ? "Standard" : option.serviceTiers.find((tier) => tier.id === chosen)?.name || "Default",
  );

  const inheritedLabel = $derived(option.serviceTiers.find((tier) => tier.id === fallback)?.name);
</script>

<DropdownMenu label="Execution speed" placement="top-end" class="w-[min(12rem,calc(100vw-1rem))]">
  {#snippet trigger(props)}
    <PillButton
      {...props}
      class="max-w-32 shrink-0"
      aria-label="Execution speed: {label}{!chosen && inheritedLabel ? ` (${inheritedLabel})` : ''}"
      chevronClass={adaptive ? "@max-[22rem]/model-controls:hidden" : undefined}
    >
      <SpeedIcon tier={chosen || fallback} />
      <span class={["truncate", adaptive && "@max-[18rem]/model-controls:hidden"]}>{label}</span>
    </PillButton>
  {/snippet}
  <MenuCheckItem checked={!chosen} onselect={() => (value = "")}>
    <span class="inline-flex min-w-0 items-center gap-2"
      ><SpeedIcon tier={fallback} /><span class="truncate">Default</span></span
    >
  </MenuCheckItem>
  <MenuCheckItem checked={chosen === "default"} onselect={() => (value = "default")}>
    <span class="inline-flex min-w-0 items-center gap-2"
      ><SpeedIcon tier="default" /><span class="truncate">Standard</span></span
    >
  </MenuCheckItem>
  {#each option.serviceTiers.filter((tier) => tier.id !== "default") as tier (tier.id)}
    <MenuCheckItem checked={chosen === tier.id} onselect={() => (value = tier.id)}>
      <span class="inline-flex min-w-0 items-center gap-2"
        ><SpeedIcon tier={tier.id} /><span class="truncate">{tier.name}</span></span
      >
    </MenuCheckItem>
  {/each}
</DropdownMenu>

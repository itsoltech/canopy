<script lang="ts">
  import type { connectors } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import ChoiceCard from "#lib/shared/ui/ChoiceCard.svelte";
  import Fieldset from "#lib/shared/ui/Fieldset.svelte";

  /** How to connect: one card per authentication method, each saying which credential it needs. */
  let {
    methods,
    value = $bindable(),
    disabled = false,
    class: className,
  }: {
    methods: readonly connectors.ConnectorAuthMethod[];
    value: string;
    disabled?: boolean;
    class?: ClassValue;
  } = $props();

  const name = $props.id();
</script>

<Fieldset legend="How to connect" {disabled} class={className}>
  <div class="grid gap-2 sm:grid-cols-2">
    {#each methods as method (method.authKind)}
      <ChoiceCard
        {name}
        checked={value === method.authKind}
        title={method.label}
        description={method.description}
        {disabled}
        onchange={() => (value = method.authKind)}
      />
    {/each}
  </div>
</Fieldset>

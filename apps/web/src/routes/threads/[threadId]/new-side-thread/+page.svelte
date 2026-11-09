<script lang="ts">
  import { applicationName } from "#lib/application-name.ts";
  import { ui } from "@canopy/contracts";
  import NewSideThread from "#lib/features/threads/components/NewSideThread.svelte";
  import { decode } from "#lib/shared/wire.ts";
  import type { PageProps } from "./$types";

  let { data, form }: PageProps = $props();
  const main = $derived(decode(ui.ThreadSchema, data.thread));
</script>

<svelte:head><title>New side thread · {applicationName}</title></svelte:head>

{#key main.id}
  <NewSideThread {main} error={form?.error} />
{/key}

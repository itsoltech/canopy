<script lang="ts">
  import Button from "#lib/shared/ui/Button.svelte";
  import SettingsRow from "#lib/shared/ui/SettingsRow.svelte";

  let { address }: { address: string } = $props();
</script>

<SettingsRow title="Gateway address">
  <p class="text-sm/5 wrap-anywhere text-muted">{address}</p>
  {#snippet control()}
    <Button size="sm" onclick={() => window.canopyDesktop?.openSettings()}>Edit gateway address</Button>
  {/snippet}
</SettingsRow>

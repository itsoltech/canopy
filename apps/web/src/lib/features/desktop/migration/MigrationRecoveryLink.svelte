<script lang="ts">
  import { onMount } from "svelte";
  import ButtonLink from "#lib/shared/ui/ButtonLink.svelte";

  let label = $state("");

  onMount(() => {
    const migration = window.canopyDesktop?.gatewayMigration;

    if (!migration) return;
    let active = true;
    void migration.status().then(
      ({ phase }) => {
        if (active && phase !== "idle" && phase !== "completed") label = "Resume migration";
      },
      () => {
        if (active) label = "Check migration";
      },
    );

    return () => {
      active = false;
    };
  });
</script>

{#if label}<ButtonLink href="/desktop/migration">{label}</ButtonLink>{/if}

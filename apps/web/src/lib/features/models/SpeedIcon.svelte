<script lang="ts">
  import Icon from "#lib/shared/ui/Icon.svelte";

  let { tier }: { tier?: string | undefined } = $props();

  const accelerated = $derived(Boolean(tier && tier !== "default"));
</script>

<span class="inline-flex h-3.5 w-6 shrink-0 items-center justify-center" aria-hidden="true">
  <Icon name={tier === "ultrafast" ? "bolt-double" : accelerated ? "bolt" : "clock"} size="sm" />
</span>

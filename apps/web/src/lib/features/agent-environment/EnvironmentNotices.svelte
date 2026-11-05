<script lang="ts">
  import ConfigNotices from "#lib/features/computers/ConfigNotices.svelte";

  /** Library items changed on two computers at once, or deleted on another one; Restore applies everywhere. */
  let { onchange }: { onchange: () => void } = $props();
  const kinds = new Set(["instruction", "skill", "marketplace", "plugin"]);
</script>

<ConfigNotices match={(n) => kinds.has(n.kind)} {onchange} />

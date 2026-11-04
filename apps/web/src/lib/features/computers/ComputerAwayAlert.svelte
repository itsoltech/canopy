<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import Alert from "#lib/shared/ui/Alert.svelte";

  /** The strip over a linked computer's thread while that computer is away (`awayReason`). */
  let { reason, class: className }: { reason: string; class?: ClassValue } = $props();
</script>

<Alert tone="warning" banner title="Read only for now" class={className}
  >{reason} You can read the synced timeline. Messages, approvals and actions are unavailable; nothing is queued. Files are
  available when its computer is connected.</Alert
>

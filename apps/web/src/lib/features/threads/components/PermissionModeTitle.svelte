<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import Badge from "#lib/shared/ui/Badge.svelte";
  import { permissionLabel, permissionLook, type PermissionModeKey } from "../labels.ts";

  /** Name of a permission mode with its applicable badge and an optional note (e.g. "Current"). */
  let {
    mode,
    fullAuto,
    note,
    class: className,
  }: {
    mode: PermissionModeKey;
    fullAuto?: boolean | undefined;
    note?: string | undefined;
    class?: ClassValue;
  } = $props();

  const look = $derived(permissionLook(mode, fullAuto));
</script>

<span class={["flex items-center gap-1.5", className]}>
  {permissionLabel(mode)}
  {#if look.badge}<Badge tone={look.tone} icon={look.icon}>{look.badge}</Badge>{/if}
  {#if note}<Badge>{note}</Badge>{/if}
</span>

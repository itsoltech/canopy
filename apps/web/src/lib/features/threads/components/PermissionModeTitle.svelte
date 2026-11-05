<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import Badge from "#lib/shared/ui/Badge.svelte";
  import { permissionLabel, permissionLook, type PermissionModeKey } from "../labels.ts";

  /** Name of a permission mode in a list of choices: full auto says it never asks, full access that it has no sandbox; `note` is a quiet tag on the same line (e.g. "Default", "Current"). */
  let {
    mode,
    note,
    class: className,
  }: { mode: PermissionModeKey; note?: string | undefined; class?: ClassValue } = $props();

  const look = $derived(permissionLook(mode));
</script>

<span class={["flex items-center gap-1.5", className]}>
  {permissionLabel(mode)}
  {#if look.badge}<Badge tone={look.tone} icon={look.icon}>{look.badge}</Badge>{/if}
  {#if note}<Badge>{note}</Badge>{/if}
</span>

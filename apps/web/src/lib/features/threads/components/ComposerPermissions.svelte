<script lang="ts">
  import type { ComposerPermissionsState } from "./composer-permissions.svelte.ts";
  import PermissionPicker from "./PermissionPicker.svelte";

  let { state, disabled = false }: { state: ComposerPermissionsState; disabled?: boolean } = $props();
</script>

<div class="grid min-w-0 justify-items-end gap-1">
  <PermissionPicker
    value={state.value}
    fullAuto={state.fullAuto}
    onselect={(mode) => {
      if (!disabled) void state.select(mode);
    }}
    disabled={disabled || state.busy}
    nextTurn={state.nextTurn}
    explanation={state.live
      ? "Applies to this turn and future messages. Full access also allows pending permissions. Other modes keep pending shell approvals."
      : state.nextTurn
        ? "Applies to the next turn. This turn and its pending approvals stay unchanged."
        : undefined}
  />
  {#if state.busy}<p class="sr-only" role="status">Changing permissions…</p>{/if}
  {#if state.error}<p class="max-w-72 text-xs/4 text-rose-700 dark:text-rose-300" role="alert">{state.error}</p>{/if}
</div>

<script lang="ts">
  import type { ComposerPermissionsState } from "./composer-permissions.svelte.ts";
  import PermissionPicker from "./PermissionPicker.svelte";

  let {
    state,
    disabled = false,
    onconfirmfullaccess,
    onmanage,
  }: {
    state: ComposerPermissionsState;
    disabled?: boolean;
    onconfirmfullaccess: () => void;
    onmanage?: (() => void) | undefined;
  } = $props();
</script>

<div class="grid max-w-full min-w-0 justify-items-end gap-1">
  <PermissionPicker
    value={state.value}
    fullAuto={state.fullAuto}
    onselect={(mode) => {
      if (!disabled) void state.select(mode);
    }}
    disabled={disabled || state.locked}
    fixed={Boolean(state.sandboxProfile)}
    sandboxProfileName={state.sandboxProfile?.name}
    {onmanage}
    scope={state.scope}
    nextTurnMode={state.nextTurnMode}
    confirmFullAccess={state.confirmFullAccess}
    {onconfirmfullaccess}
    explanation={state.explanation}
  />
  {#if state.busy}<p class="sr-only" role="status">Changing permissions…</p>{/if}
  {#if state.error}<p class="max-w-72 text-xs/4 text-rose-700 dark:text-rose-300" role="alert">{state.error}</p>{/if}
</div>

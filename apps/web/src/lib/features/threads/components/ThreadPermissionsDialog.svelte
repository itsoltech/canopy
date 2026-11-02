<script lang="ts">
  import type { ui } from "@open-agents/contracts";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import DialogActions from "#lib/shared/ui/DialogActions.svelte";
  import Radio from "#lib/shared/ui/Radio.svelte";
  import { updateThread } from "../api.ts";
  import { isFullAuto, permissionKey, permissionModes, type PermissionModeKey } from "../labels.ts";
  import PermissionModeTitle from "./PermissionModeTitle.svelte";

  /**
   * The thread's default permission mode (UpdateThread): what turns run with when the composer sends no
   * mode of its own. Takes effect from the next turn; approvals a running turn waits for are unchanged.
   * The new default arrives through the thread's stream.
   */
  let { open = $bindable(false), thread }: { open?: boolean; thread: ui.Thread } = $props();

  const current = $derived(permissionKey(thread.permissionMode));
  // Edits start from the thread's default each time the dialog opens.
  let picked = $state<PermissionModeKey>();
  $effect.pre(() => {
    if (open) picked = undefined;
  });
  const mode = $derived(picked ?? current);
  let busy = $state(false);
  let error = $state<string>();
  const id = $props.id();

  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (mode === current) return void (open = false);
    busy = true;
    error = undefined;
    try {
      await updateThread(thread.id, { permissionMode: mode });
      open = false;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      busy = false;
    }
  }
</script>

<Dialog bind:open title="Permissions" description="Turns use this mode unless you choose otherwise in the composer for a message. It applies from the next turn.">
  <form class="grid gap-4" onsubmit={save}>
    <fieldset class="grid gap-1" aria-label="Permission mode">
      {#each permissionModes as option (option.value)}
        {@const warn = isFullAuto(option.value)}
        <label
          class={[
            "flex cursor-pointer gap-3 rounded-lg p-3 ring-1 ring-transparent hover:bg-zinc-950/2.5 has-checked:ring-zinc-950/10 dark:hover:bg-white/2.5 dark:has-checked:ring-white/10",
            warn && "has-checked:bg-amber-50 has-checked:ring-amber-600/25 dark:has-checked:bg-amber-400/5 dark:has-checked:ring-amber-400/20",
          ]}
        >
          <span class="flex h-lh items-center text-base/6 sm:text-sm/6">
            <Radio name="{id}-mode" value={option.value} checked={option.value === mode} onchange={() => (picked = option.value)} aria-describedby="{id}-{option.value}" />
          </span>
          <span class="grid min-w-0 gap-0.5 text-base/6 sm:text-sm/6">
            <PermissionModeTitle mode={option.value} note={option.value === current ? "Current" : undefined} class="font-medium text-zinc-950 dark:text-white" />
            <span id="{id}-{option.value}" class="text-zinc-500 dark:text-zinc-400">{option.description}</span>
          </span>
        </label>
      {/each}
    </fieldset>
    {#if isFullAuto(mode) && mode !== current}
      <Alert tone="warning">Every turn without a mode of its own will edit files and run commands without asking. It stays sandboxed to the workspace.</Alert>
    {/if}
    {#if error}<Alert tone="error">{error}</Alert>{/if}
    <DialogActions>
      <Button onclick={() => (open = false)}>Cancel</Button>
      <Button type="submit" variant="primary" loading={busy}>Save</Button>
    </DialogActions>
  </form>
</Dialog>

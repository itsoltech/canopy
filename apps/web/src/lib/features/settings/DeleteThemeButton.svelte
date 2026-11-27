<script lang="ts">
  import Button from "#lib/shared/ui/Button.svelte";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import DialogActions from "#lib/shared/ui/DialogActions.svelte";
  import { toast } from "#lib/shared/ui/toast.svelte.ts";
  import { dropTheme, type CustomTheme } from "./custom-themes.ts";
  import { customThemes } from "./custom-themes.svelte.ts";
  import { useSettings } from "./settings-state.svelte.ts";

  /** Deletes a saved custom theme after confirmation; `ondeleted` runs once the dialog has closed. */
  let { theme, ondeleted }: { theme: CustomTheme; ondeleted: () => void } = $props();

  const settings = useSettings();
  let open = $state(false);
  let deleted = false;

  function confirm() {
    open = false;

    if (!customThemes.remove(theme.id)) return;
    const change = dropTheme(settings.appearance, theme);

    if (Object.keys(change).length) settings.updateAppearance(change);
    toast("Theme deleted");
    deleted = true;
  }
</script>

<Button size="sm" variant="ghost" icon="trash" onclick={() => (open = true)}>Delete theme</Button>

<Dialog
  bind:open
  title="Delete theme?"
  onexited={() => {
    if (deleted) ondeleted();
  }}
>
  <p class="text-base/6 text-pretty text-muted sm:text-sm/6">
    This deletes “{theme.name}” from this device. If you use it, its base palette replaces it.
  </p>
  {#snippet footer()}
    <DialogActions>
      <Button data-autofocus onclick={() => (open = false)}>Cancel</Button>
      <Button variant="danger" icon="trash" onclick={confirm}>Delete theme</Button>
    </DialogActions>
  {/snippet}
</Dialog>

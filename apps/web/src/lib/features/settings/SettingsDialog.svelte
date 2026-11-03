<script lang="ts">
  import type { Snippet } from "svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import { exitDuration } from "#lib/shared/ui/motion.ts";
  import SettingsBreadcrumb from "./SettingsBreadcrumb.svelte";
  import { useSettings } from "./settings-state.svelte.ts";
  import SettingsNav from "./SettingsNav.svelte";
  import { windowModal } from "#lib/shared/ui/window-modal.ts";

  /**
   * Settings as a large modal panel (T3 layout): searchable section nav on the left, the section on the
   * right; a full-screen sheet on phones. A native modal `<dialog>`: the page underneath is inert, focus
   * stays inside and goes back to the opener on close. Escape, the close button or a click on the
   * backdrop ask to close (`onclose`); `open` going false plays the exit (motion.css `t-modal`), then
   * `onexited`. On macOS its top row is a title strip (routes/layout.css).
   */
  let { open, onclose, onexited, children }: { open: boolean; onclose: () => void; onexited: () => void; children: Snippet } = $props();
  const settings = useSettings();

  let dialog = $state<HTMLDialogElement>();
  let exited: ReturnType<typeof setTimeout> | undefined;
  $effect(() => () => clearTimeout(exited));
  $effect(() => {
    if (!dialog) return;
    if (open && !dialog.matches(":modal")) {
      clearTimeout(exited);
      // Rendered open (on the server too, non-modal); reopen as modal for focus trapping and an inert page.
      if (dialog.open) dialog.close();
      dialog.showModal();
      // Start in the settings search (on narrow screens it is hidden: the close button gets focus).
      const search = dialog.querySelector<HTMLElement>("[data-autofocus]");
      if (search?.checkVisibility()) search.focus();
      else dialog.querySelector<HTMLElement>("[aria-label='Close settings']")?.focus();
    }
    if (!open && dialog.open) {
      dialog.close();
      exited = setTimeout(onexited, exitDuration(dialog));
    }
  });
</script>

<dialog
  use:windowModal
  bind:this={dialog}
  open
  aria-labelledby="settings-title"
  inert={!open || undefined}
  oncancel={(event) => {
    event.preventDefault();
    onclose();
  }}
  onclick={(event) => {
    if (event.target === dialog) onclose();
  }}
  class="t-modal fixed inset-x-0 bottom-0 top-(--window-safe-top) m-0 h-(--window-safe-height) max-h-none w-full max-w-none overflow-hidden bg-white p-0 text-zinc-950 backdrop:bg-zinc-950/40 backdrop:backdrop-blur-[2px] sm:m-auto sm:h-[min(var(--window-safe-height)-3rem,60rem)] sm:w-[min(100vw-3rem,76rem)] sm:rounded-2xl sm:shadow-2xl sm:ring-1 sm:ring-zinc-950/10 dark:bg-zinc-950 dark:text-white dark:backdrop:bg-black/70 dark:sm:shadow-none dark:sm:ring-white/10"
>
  <div class="flex h-full flex-col lg:flex-row">
    <div class="shrink-0 border-zinc-950/5 bg-zinc-50 px-3 pt-3 pb-2 lg:w-64 lg:overflow-y-auto lg:border-r lg:pb-4 dark:border-white/8 dark:bg-white/2">
      <SettingsNav />
    </div>
    <div class="flex min-h-0 min-w-0 flex-1 flex-col">
      <div class="flex h-12 shrink-0 items-center gap-2 border-b border-zinc-950/5 pr-2 pl-5 dark:border-white/8" data-window-drag>
        <SettingsBreadcrumb class="flex-1" />
        <IconButton icon="x-mark" label="Close settings" onclick={onclose} />
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto">
        <div class="mx-auto grid max-w-3xl grid-cols-1 gap-10 px-4 py-6 sm:px-8 lg:py-8">
          {#if settings.notice}
            <Alert tone={settings.notice.tone}>
              {settings.notice.text}
              {#snippet actions()}<IconButton icon="x-mark" label="Dismiss" size="sm" onclick={() => settings.dismissNotice()} />{/snippet}
            </Alert>
          {/if}
          {@render children()}
        </div>
      </div>
    </div>
  </div>
</dialog>

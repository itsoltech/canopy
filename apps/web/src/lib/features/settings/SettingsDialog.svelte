<script lang="ts">
  import { tick, type Snippet } from "svelte";
  import { paletteStyle } from "@canopy/ui/themes";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import { exitDuration } from "#lib/shared/ui/motion.ts";
  import { backdropDismiss } from "#lib/shared/ui/backdrop.ts";
  import SettingsBreadcrumb from "./SettingsBreadcrumb.svelte";
  import { useSettings } from "./settings-state.svelte.ts";
  import { useSettingsRoute } from "./settings-route.ts";
  import { highlightSettingsMatches, provideSettingsSearch } from "./settings-search.ts";
  import SettingsNav from "./SettingsNav.svelte";
  import Toaster from "#lib/shared/ui/Toaster.svelte";
  import { windowModal } from "#lib/shared/ui/window-modal.ts";
  import { appearanceState } from "./appearance-state.svelte.ts";
  import { provideSettingsThemePreview, type SettingsThemePreview } from "./settings-theme-preview.ts";
  import "./density.css";

  /**
   * Settings as a large modal panel: searchable section nav on the left, the section on the
   * right; a full-screen sheet on phones, where a section menu in the top row takes the nav's place. A native modal `<dialog>`: the page underneath is inert, focus
   * stays inside and goes back to the opener on close. Escape, the close button or a click on the
   * backdrop ask to close (`onclose`); `open` going false plays the exit (motion.css `t-modal`), then
   * `onexited`. On desktop its top row is a title strip (routes/layout.css).
   */
  let {
    open,
    canPreview,
    focused,
    onclose,
    onexited,
    children,
  }: {
    open: boolean;
    canPreview: boolean;
    focused: boolean;
    onclose: () => void;
    onexited: () => void;
    children: Snippet;
  } = $props();

  const settings = useSettings();
  const route = useSettingsRoute();
  let pane = $state<HTMLElement>();
  const sectionPath = $derived(route.url.pathname);
  const sectionTopic = $derived(sectionPath + route.url.hash);
  let preview = $state.raw<SettingsThemePreview>();
  const activePreview = $derived(open && canPreview ? preview : undefined);
  const previewControlsStyle = $derived(activePreview ? paletteStyle("birch", "birch") : undefined);
  let dialogHeight = $state(0);

  provideSettingsThemePreview({
    get available() {
      return canPreview;
    },
    start(session) {
      if (canPreview) preview = session;
    },
  });

  function exitPreview() {
    const opener = preview?.opener;
    preview = undefined;
    void tick().then(() => opener?.focus({ preventScroll: true }));
  }

  function cancel() {
    if (activePreview) exitPreview();
    else onclose();
  }

  $effect(() => {
    void sectionTopic;
    preview = undefined;
  });

  $effect(() => {
    if (!open || !canPreview) preview = undefined;
  });

  $effect(() => {
    if (!activePreview) return;
    appearanceState.preview = { options: activePreview.options, mode: activePreview.mode };

    return () => (appearanceState.preview = undefined);
  });

  $effect(() => {
    if (!activePreview) return;
    const root = document.documentElement;
    root.style.setProperty("--settings-theme-preview-height", `${dialogHeight}px`);

    return () => root.style.removeProperty("--settings-theme-preview-height");
  });

  $effect(() => {
    void sectionPath;
    pane?.scrollTo({ top: 0 });
  });

  let query = $state("");
  const searchQuery = $derived(focused ? "" : query.trim());
  let matchedPanel = $state<string>();

  provideSettingsSearch({
    get query() {
      return searchQuery;
    },
    get panel() {
      return matchedPanel;
    },
  });

  let dialog = $state<HTMLDialogElement>();
  let exited: ReturnType<typeof setTimeout> | undefined;

  $effect(() => () => clearTimeout(exited));

  $effect(() => {
    if (activePreview) dialog?.querySelector<HTMLElement>("[data-exit-theme-preview]")?.focus();
  });

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
  data-window-drag-top={!activePreview || undefined}
  data-settings-theme-preview={!!activePreview || undefined}
  style={previewControlsStyle}
  class:settings-density={true}
  bind:this={dialog}
  bind:offsetHeight={dialogHeight}
  open
  aria-label={activePreview ? "Theme preview" : undefined}
  aria-labelledby={activePreview ? undefined : "settings-title"}
  inert={!open || undefined}
  oncancel={(event) => {
    event.preventDefault();
    cancel();
  }}
  {...backdropDismiss(cancel)}
  class={activePreview
    ? "fixed inset-x-0 top-auto bottom-0 m-0 max-h-[40dvh] w-full max-w-none overflow-auto border-t border-divider bg-surface p-0 pb-[env(safe-area-inset-bottom)] text-ink backdrop:bg-transparent"
    : [
        "fixed inset-x-0 top-(--window-safe-top) bottom-0 m-0 h-(--window-safe-height) max-h-none w-full max-w-none overflow-hidden p-0",
        focused
          ? "bg-canvas text-ink backdrop:bg-transparent"
          : "t-modal bg-white text-zinc-950 backdrop:bg-zinc-950/40 backdrop:backdrop-blur-[2px] sm:m-auto sm:h-[min(var(--window-safe-height)-3rem,60rem)] sm:w-[min(100vw-3rem,76rem)] sm:rounded-2xl sm:shadow-2xl sm:ring-1 sm:ring-zinc-950/10 dark:bg-zinc-950 dark:text-white dark:backdrop:bg-black/70 dark:sm:shadow-none dark:sm:ring-white/10",
      ]}
>
  {#if activePreview}{@render activePreview.controls(exitPreview)}{/if}
  <div class="flex h-full" hidden={!!activePreview}>
    {#if !focused}
      <div
        class="w-(--settings-nav-width) shrink-0 border-r border-zinc-950/5 bg-zinc-50 max-lg:hidden dark:border-white/8 dark:bg-white/2"
      >
        <SettingsNav bind:query />
      </div>
    {/if}
    <div class="flex min-h-0 min-w-0 flex-1 flex-col">
      {#if focused}
        <div class="border-b border-divider" data-window-drag>
          <div class="mx-auto flex min-h-12 max-w-(--settings-content-width) items-center px-4 sm:px-6">
            <Button variant="ghost" icon="arrow-left" data-autofocus onclick={onclose}>Back</Button>
            <SettingsBreadcrumb focused bind:query />
          </div>
        </div>
      {:else}
        <div
          class="flex min-h-11 shrink-0 items-center gap-2 border-b border-zinc-950/5 pr-2 pl-4 dark:border-white/8"
          data-window-drag
        >
          <SettingsBreadcrumb class="flex-1" bind:query />
          <IconButton icon="x-mark" label="Close settings" onclick={onclose} />
        </div>
      {/if}
      <div
        bind:this={pane}
        class="min-h-0 flex-1 scroll-stable overflow-y-auto has-[[role=tabpanel]:not([hidden])_[data-theme-builder-actions]]:scroll-pb-32"
      >
        <div
          {@attach highlightSettingsMatches(searchQuery, (panel) => (matchedPanel = panel))}
          class="settings-content mx-auto grid grid-cols-1 px-4 py-4 sm:px-6 lg:py-5"
        >
          {#if settings.notice}
            <Alert tone={settings.notice.tone}>
              {settings.notice.text}
              {#snippet actions()}<IconButton
                  icon="x-mark"
                  label="Dismiss"
                  size="sm"
                  onclick={() => settings.dismissNotice()}
                />{/snippet}
            </Alert>
          {/if}
          {@render children()}
        </div>
      </div>
    </div>
  </div>
  {#if open}<Toaster inDialog />{/if}
</dialog>

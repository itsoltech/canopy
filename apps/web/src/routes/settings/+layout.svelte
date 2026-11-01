<script lang="ts">
  import type { Snippet } from "svelte";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import { returnTo } from "#lib/features/settings/return-to.svelte.ts";
  import { useSettings } from "#lib/features/settings/settings-state.svelte.ts";
  import { settingsSections } from "#lib/features/settings/sections.ts";
  import SettingsNav from "#lib/features/settings/SettingsNav.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import { exitDuration } from "#lib/shared/ui/motion.ts";

  /**
   * Settings as a large modal panel over the app (T3 layout): searchable section nav on the left, the
   * section on the right. Escape, the close button or a click on the backdrop go back to where you were,
   * after the panel scaled out (motion.css `t-modal`, `data-closing`).
   */
  let { children }: { children: Snippet } = $props();
  const overview = useOverview();
  const settings = useSettings();

  const section = $derived(settingsSections.find((s) => page.url.pathname.startsWith(s.href)));
  const project = $derived(page.params.projectId ? overview.project(page.params.projectId) : undefined);

  let dialog = $state<HTMLDialogElement>();
  let leaving = $state(false);
  $effect(() => {
    // Rendered open on the server (non-modal); reopen as modal for focus trapping and an inert background.
    if (!dialog) return;
    if (dialog.open) dialog.close();
    dialog.showModal();
    // Start in the settings search (on narrow screens it is hidden: the close button gets focus).
    const search = dialog.querySelector<HTMLElement>("[data-autofocus]");
    if (search?.checkVisibility()) search.focus();
    else dialog.querySelector<HTMLElement>("[aria-label='Close settings']")?.focus();
  });
  function close() {
    if (leaving) return;
    leaving = true;
    // Let the exit play (its duration is the closing rule's, 0 without motion), then leave.
    requestAnimationFrame(() => setTimeout(() => void goto(returnTo.url).finally(() => (leaving = false)), dialog ? exitDuration(dialog) : 0));
  }
</script>

<dialog
  bind:this={dialog}
  open
  data-closing={leaving || undefined}
  aria-labelledby="settings-title"
  oncancel={(event) => {
    event.preventDefault();
    close();
  }}
  onclick={(event) => {
    if (event.target === dialog) close();
  }}
  class="t-modal fixed inset-0 m-0 h-dvh max-h-none w-full max-w-none overflow-hidden bg-white p-0 text-zinc-950 backdrop:bg-zinc-950/40 backdrop:backdrop-blur-[2px] sm:m-auto sm:h-[min(100dvh-3rem,60rem)] sm:w-[min(100vw-3rem,76rem)] sm:rounded-2xl sm:shadow-2xl sm:ring-1 sm:ring-zinc-950/10 dark:bg-zinc-950 dark:text-white dark:backdrop:bg-black/70 dark:sm:shadow-none dark:sm:ring-white/10"
>
  <div class="flex h-full flex-col lg:flex-row">
    <div class="shrink-0 border-zinc-950/5 bg-zinc-50 px-3 pt-3 pb-2 lg:w-64 lg:overflow-y-auto lg:border-r lg:pb-4 dark:border-white/8 dark:bg-white/2">
      <SettingsNav />
    </div>
    <div class="flex min-h-0 min-w-0 flex-1 flex-col">
      <div class="flex h-12 shrink-0 items-center gap-2 border-b border-zinc-950/5 pr-2 pl-5 dark:border-white/8">
        <nav aria-label="Breadcrumb" class="min-w-0 flex-1">
          <ol role="list" class="flex min-w-0 items-center gap-2 text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
            <li><a href="/settings" class="rounded-sm hover:text-zinc-950 focus-ring dark:hover:text-white">Settings</a></li>
            <li class="flex min-w-0 items-center gap-2 before:text-zinc-300 before:content-['/'] dark:before:text-zinc-700">
              {#if project}
                <a href="/settings/projects" class="rounded-sm hover:text-zinc-950 focus-ring dark:hover:text-white">Projects</a>
              {:else}
                <span id="settings-title" class="truncate text-zinc-950 dark:text-white">{section?.label ?? "Settings"}</span>
              {/if}
            </li>
            {#if project}
              <li class="flex min-w-0 items-center gap-2 before:text-zinc-300 before:content-['/'] dark:before:text-zinc-700">
                <span id="settings-title" class="truncate text-zinc-950 dark:text-white">{project.name}</span>
              </li>
            {/if}
          </ol>
        </nav>
        <IconButton icon="x-mark" label="Close settings" onclick={close} />
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

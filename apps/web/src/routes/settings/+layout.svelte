<script lang="ts">
  import type { Snippet } from "svelte";
  import { page } from "$app/state";
  import Crumb from "#lib/features/navigation/Crumb.svelte";
  import TopBar from "#lib/features/navigation/TopBar.svelte";
  import SettingsNav from "#lib/features/settings/SettingsNav.svelte";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import Icon from "#lib/shared/ui/Icon.svelte";

  /** Settings: section navigation on the left, the section on the right (T3 layout). */
  let { children }: { children: Snippet } = $props();
  const overview = useOverview();
  const titles: Record<string, string> = { projects: "Projects", workers: "Workers", appearance: "Appearance" };
  const section = $derived(page.url.pathname.split("/")[2] ?? "");
  const project = $derived(page.params.projectId ? overview.project(page.params.projectId) : undefined);
</script>

<div class="flex h-full flex-col">
  <TopBar>
    <Crumb href="/settings">Settings</Crumb>
    {#if project}
      <Crumb href="/settings/projects">Projects</Crumb>
      <Crumb>{project.name}</Crumb>
    {:else}
      <Crumb>{titles[section] ?? "Settings"}</Crumb>
    {/if}
    {#snippet actions()}
      <a href="/" class="relative grid size-9 place-items-center rounded-lg text-zinc-500 hover:bg-zinc-950/5 hover:text-zinc-950 focus-ring sm:size-8 dark:text-zinc-400 dark:hover:bg-white/5 dark:hover:text-white" aria-label="Close settings" title="Close">
        <Icon name="x-mark" />
      </a>
    {/snippet}
  </TopBar>
  <div class="flex min-h-0 flex-1 flex-col lg:flex-row">
    <div class="shrink-0 px-4 py-2 sm:px-6 lg:w-60 lg:overflow-y-auto lg:py-6 lg:pr-0 lg:pl-4">
      <SettingsNav />
    </div>
    <div class="min-h-0 flex-1 overflow-y-auto">
      <div class="mx-auto grid max-w-3xl gap-10 px-4 py-6 sm:px-6 lg:py-8">
        {@render children()}
      </div>
    </div>
  </div>
</div>

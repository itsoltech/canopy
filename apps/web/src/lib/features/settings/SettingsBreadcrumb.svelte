<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import Crumb from "#lib/features/navigation/Crumb.svelte";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import { useSettingsRoute } from "./settings-route.ts";
  import { useSettingsSections } from "./settings-sections.svelte.ts";
  import SettingsSectionMenu from "./SettingsSectionMenu.svelte";

  /**
   * Settings › section, or Settings › section › page below it (a project, a worker): the crumbs link back,
   * the page's name keeps its room. On narrow screens the section is a menu of every section
   * (`SettingsSectionMenu`) in place of the first two crumbs. `#settings-title` names the dialog.
   */
  let { class: className }: { class?: ClassValue } = $props();
  const overview = useOverview();
  const route = useSettingsRoute();
  const sections = useSettingsSections();

  const section = $derived(sections.current);
  const project = $derived(route.params.projectId ? overview.project(route.params.projectId) : undefined);
  const worker = $derived(route.params.workerId ? overview.worker(route.params.workerId) : undefined);
  const leaf = $derived(project?.name ?? worker?.name);
</script>

<nav aria-label="Breadcrumb" class={["min-w-0", className]}>
  <ol
    role="list"
    class="flex min-w-0 items-center gap-2 text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400 [&_[aria-current=page]]:text-zinc-950 dark:[&_[aria-current=page]]:text-white"
  >
    <Crumb href="/settings" class="max-lg:hidden">Settings</Crumb>
    {#if leaf}
      <Crumb href={section?.href} current={false} class="max-lg:hidden">{section?.label}</Crumb>
    {:else}
      <Crumb class="max-lg:hidden">{section?.label ?? "Settings"}</Crumb>
    {/if}
    <li class="-ml-2 flex shrink-0 items-center lg:hidden"><SettingsSectionMenu /></li>
    {#if leaf}<Crumb>{leaf}</Crumb>{/if}
  </ol>
  <span id="settings-title" class="sr-only">{leaf ?? section?.label ?? "Settings"}</span>
</nav>

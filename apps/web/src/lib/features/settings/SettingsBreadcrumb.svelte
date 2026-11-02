<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import { settingsSections } from "./sections.ts";
  import { useSettingsRoute } from "./settings-route.ts";

  /**
   * Settings › section, or Settings › section › page below it (a project, a worker): the crumbs link
   * back, the last one names the dialog (`#settings-title`).
   */
  let { class: className }: { class?: ClassValue } = $props();
  const overview = useOverview();
  const route = useSettingsRoute();

  const section = $derived(settingsSections.find((s) => route.url.pathname.startsWith(s.href)));
  const project = $derived(route.params.projectId ? overview.project(route.params.projectId) : undefined);
  const worker = $derived(route.params.workerId ? overview.worker(route.params.workerId) : undefined);
  const crumbs = $derived<{ label: string; href?: string }[]>(
    project
      ? [{ label: "Projects", href: "/settings/projects" }, { label: project.name }]
      : worker
        ? [{ label: "Workers", href: "/settings/workers" }, { label: worker.name }]
        : [{ label: section?.label ?? "Settings" }],
  );
  const linkClass = "rounded-sm hover:text-zinc-950 focus-ring dark:hover:text-white";
</script>

<nav aria-label="Breadcrumb" class={["min-w-0", className]}>
  <ol role="list" class="flex min-w-0 items-center gap-2 text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
    <li><a href="/settings" class={linkClass}>Settings</a></li>
    {#each crumbs as crumb, index (index)}
      <li class="flex min-w-0 items-center gap-2 before:text-zinc-300 before:content-['/'] dark:before:text-zinc-700">
        {#if crumb.href}
          <a href={crumb.href} class={linkClass}>{crumb.label}</a>
        {:else}
          <span id="settings-title" class="truncate text-zinc-950 dark:text-white">{crumb.label}</span>
        {/if}
      </li>
    {/each}
  </ol>
</nav>

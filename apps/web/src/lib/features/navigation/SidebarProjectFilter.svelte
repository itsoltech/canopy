<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import { useSettings } from "#lib/features/settings/settings-state.svelte.ts";
  import Popover from "#lib/shared/ui/Popover.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Input from "#lib/shared/ui/Input.svelte";
  import SidebarProjectChoice from "./SidebarProjectChoice.svelte";

  let { class: className }: { class?: ClassValue } = $props();
  const overview = useOverview();
  const settings = useSettings();
  let search = $state("");
  const selected = $derived(settings.sidebar.projectIds);
  const active = $derived(selected.length > 0);

  const projects = $derived(
    overview.projects.filter((p) => p.name.toLowerCase().includes(search.trim().toLowerCase())),
  );

  const choose = (id: string, checked: boolean) =>
    void settings.updateSidebar({
      projectIds: checked ? [...new Set([...selected, id])] : selected.filter((x) => x !== id),
    });
</script>

<div class={["flex shrink-0 items-center gap-1", className]}>
  <Popover label="Filter threads" sheet placement="bottom-end" class="w-80 max-w-[calc(100vw-1rem)] p-2">
    {#snippet trigger(props)}
      <button
        type="button"
        {...props}
        aria-label={active ? `Filter projects (${selected.length} selected)` : "Filter projects"}
        class={[
          "relative flex h-9 items-center gap-1 rounded-lg px-2 text-sm/5 focus-ring sm:h-8",
          active
            ? "bg-brand-500/10 text-brand-700 dark:text-brand-300"
            : "text-zinc-500 hover:bg-zinc-950/5 dark:text-zinc-400 dark:hover:bg-white/5",
        ]}
      >
        <Icon name="bars-3" />
        {#if selected.length}<span class="min-w-3 tabular-nums">{selected.length}</span>{/if}
      </button>
    {/snippet}
    <div class="grid gap-2">
      <Input
        type="search"
        name="project-search"
        aria-label="Search projects"
        placeholder="Search projects"
        bind:value={search}
        data-autofocus
      />
      <Button
        variant="ghost"
        icon="folder"
        aria-pressed={selected.length === 0}
        onclick={() => void settings.updateSidebar({ projectIds: [] })}
        class="justify-start"
      >
        <span class="min-w-0 flex-1 text-left">All projects</span>{#if !selected.length}<Icon name="check" />{/if}
      </Button>
      <div class="max-h-72 overflow-y-auto" role="group" aria-label="Projects">
        {#each projects as project (project.id)}
          <SidebarProjectChoice
            {project}
            checked={selected.includes(project.id)}
            onchoose={(checked) => choose(project.id, checked)}
          />
        {:else}<p class="px-2 py-3 text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
            No projects found.
          </p>{/each}
      </div>
      {#if active}<Button variant="ghost" onclick={() => void settings.updateSidebar({ projectIds: [] })}
          >Clear filters</Button
        >{/if}
    </div>
  </Popover>
  {#if active}<IconButton
      size="sm"
      icon="x-mark"
      label="Clear filters"
      onclick={() => void settings.updateSidebar({ projectIds: [] })}
    />{/if}
</div>

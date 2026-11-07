<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import ButtonLink from "#lib/shared/ui/ButtonLink.svelte";
  import Checkbox from "#lib/shared/ui/Checkbox.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import ProjectMark from "#lib/shared/ui/ProjectMark.svelte";

  let {
    project,
    checked,
    onchoose,
    class: className,
  }: { project: ui.Project; checked: boolean; onchoose: (checked: boolean) => void; class?: ClassValue } = $props();

  const overview = useOverview();

  const workers = $derived(
    project.workspaces.map((w) => overview.worker(w.workerId)?.name ?? "Unknown worker").join(", "),
  );
</script>

<div
  title={overview.projectAway(project)}
  class={[
    "flex min-w-0 items-center gap-2 rounded-lg px-2 py-1 sm:py-0",
    overview.projectAway(project) && "opacity-50",
    className,
  ]}
>
  <ProjectMark name={project.name} kind={project.kind} />
  <Checkbox
    name="project-{project.id}"
    label={project.name}
    class="min-w-0 flex-1"
    bind:checked={() => checked, onchoose}
  />
  {#if overview.projectAway(project)}<span class="text-xs/4 text-zinc-500 dark:text-zinc-400">Offline</span>{/if}
  <Icon name="computer-desktop" label={workers || "No workers"} class="fill-zinc-400 dark:fill-zinc-500" />
  <ButtonLink
    href={project.kind === "scratch" ? "/settings/threads" : `/settings/projects/${project.id}`}
    variant="ghost"
    size="sm"
    icon="cog-6-tooth"
    class="px-1"
  >
    <span class="sr-only">Settings for {project.name}</span>
  </ButtonLink>
</div>

<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import { formatCount } from "#lib/shared/format.ts";
  import Button from "#lib/shared/ui/Button.svelte";
  import Checkbox from "#lib/shared/ui/Checkbox.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import Popover from "#lib/shared/ui/Popover.svelte";
  import SearchField from "#lib/shared/ui/SearchField.svelte";

  let {
    projects,
    value,
    disabled,
    onchange,
  }: {
    projects: ui.MemoryReflectionProject[];
    value: readonly string[];
    disabled: boolean;
    onchange: (value: string[]) => void;
  } = $props();

  let query = $state("");
  const missing = $derived(value.filter((id) => !projects.some((project) => project.id === id)));

  const choices = $derived(
    [...projects, ...missing.map((id) => ({ id, name: "Unavailable project" }))].filter((project) =>
      project.name.toLowerCase().includes(query.trim().toLowerCase()),
    ),
  );

  const label = $derived(value.length ? `${formatCount(value.length)} selected` : "Choose projects");

  function choose(id: string, checked: boolean) {
    onchange(checked ? [...value, id] : value.filter((selected) => selected !== id));
  }
</script>

<Popover
  label="Projects"
  sheet
  placement="bottom-end"
  class="w-72 max-w-[calc(100vw-1rem)] p-2"
  onclose={() => (query = "")}
>
  {#snippet trigger(props)}
    <Button
      {...props}
      disabled={disabled || (!projects.length && !value.length)}
      aria-label={value.length ? `Projects · ${label}` : label}
    >
      {label}
      <Icon name="chevron-up-down" tone="muted" />
    </Button>
  {/snippet}
  <SearchField
    name="habit-project-search"
    label="Find a project"
    placeholder="Find a project"
    bind:value={query}
    data-autofocus
  />
  <div class="mt-1 max-h-64 overflow-y-auto px-1" role="group" aria-label="Projects">
    {#each choices as project (project.id)}
      <Checkbox
        name="habit-project"
        value={project.id}
        label={project.name}
        {disabled}
        bind:checked={() => value.includes(project.id), (checked) => choose(project.id, checked)}
        class="min-h-7 items-center py-1 pointer-coarse:min-h-11"
      />
    {:else}
      <p class="py-2 text-sm/5 text-muted">No projects found</p>
    {/each}
  </div>
</Popover>

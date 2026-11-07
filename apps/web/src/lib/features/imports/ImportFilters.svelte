<script lang="ts">
  import SearchField from "#lib/shared/ui/SearchField.svelte";
  import SegmentedChoice from "#lib/shared/ui/SegmentedChoice.svelte";
  import Switch from "#lib/shared/ui/Switch.svelte";
  import { periodOf, type ImportState } from "./import-state.svelte.ts";

  /** Filters of the thread list; every change selects what matches again (docs/import.md). */
  let { imports }: { imports: ImportState } = $props();

  // Local copies of the filters (the page's state starts with all agent CLIs and the last 30 days).
  let agent = $state("");
  let period = $state<string>("30d");
  let search = $state("");
  let subagents = $state(false);

  const agents = [
    { value: "", label: "All" },
    { value: "claude", label: "Claude Code" },
    { value: "codex", label: "Codex" },
    { value: "grok", label: "Grok" },
  ];

  const periods = [
    { value: "7d", label: "7 days" },
    { value: "30d", label: "30 days" },
    { value: "90d", label: "90 days" },
    { value: "all", label: "All time" },
  ];

  // Choices apply at once; typing waits for a pause.
  $effect(() => {
    const next = { agentClis: agent ? [agent] : [], period: periodOf(period), includeSubagents: subagents };

    if (
      next.agentClis.join() === imports.agentClis.join() &&
      next.period === imports.period &&
      next.includeSubagents === imports.includeSubagents
    )
      return;
    Object.assign(imports, next);
    imports.refilter();
  });

  $effect(() => {
    const value = search;

    if (value === imports.search) return;

    const timer = setTimeout(() => {
      imports.search = value;
      imports.refilter();
    }, 250);

    return () => clearTimeout(timer);
  });
</script>

<div class="flex flex-col gap-3 px-4 py-3">
  <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
    <SegmentedChoice label="Agent CLI" options={agents} bind:value={agent} />
    <SegmentedChoice label="Last activity" options={periods} bind:value={period} />
  </div>
  <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
    <SearchField label="Search titles" placeholder="Search titles" bind:value={search} class="w-full sm:w-72" />
    <Switch name="includeSubagents" label="Include subagent threads" bind:checked={subagents} />
  </div>
</div>

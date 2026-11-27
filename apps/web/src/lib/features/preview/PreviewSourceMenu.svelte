<script lang="ts">
  import { AgentTool } from "@canopy/contracts";
  import DropdownMenu from "#lib/shared/ui/DropdownMenu.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import type { IconName } from "#lib/shared/ui/icons.ts";
  import MenuItem from "#lib/shared/ui/MenuItem.svelte";
  import { tooltip } from "#lib/shared/ui/tooltip.ts";
  import TouchTarget from "#lib/shared/ui/TouchTarget.svelte";

  let { tool, onchange }: { tool: AgentTool; onchange: (tool: AgentTool) => void } = $props();

  const sources: { tool: AgentTool; label: string; icon: IconName; description: string }[] = [
    { tool: AgentTool.BROWSER, label: "Browser", icon: "globe-alt", description: "Pages in this thread’s browser" },
    { tool: AgentTool.DESKTOP, label: "Desktop", icon: "computer-desktop", description: "Windows on this computer" },
    { tool: AgentTool.DEVICE, label: "Device", icon: "device-mobile", description: "Phones and simulators" },
  ];

  const current = $derived(sources.find((source) => source.tool === tool) ?? sources[0]);
</script>

<DropdownMenu label="Preview source" placement="bottom-start">
  {#snippet trigger(props)}
    <button
      type="button"
      class="relative inline-flex h-8 shrink-0 items-center gap-1 rounded-md px-1.5 text-(length:--type-compact) font-medium text-zinc-700 focus-ring hover:bg-zinc-950/5 aria-expanded:bg-zinc-950/5 sm:h-7 dark:text-zinc-300 dark:hover:bg-white/10 dark:aria-expanded:bg-white/10"
      aria-label={`Preview source: ${current?.label}`}
      {...props}
      {@attach tooltip(`Preview source: ${current?.label}`)}
    >
      {#if current}<Icon name={current.icon} />{/if}
      <span class={[tool === AgentTool.BROWSER && "hidden @2xl:inline"]}>{current?.label}</span>
      <Icon name="chevron-down" size="xs" />
      <TouchTarget />
    </button>
  {/snippet}
  {#each sources as source (source.tool)}
    <MenuItem
      icon={source.icon}
      description={source.description}
      current={source.tool === tool}
      onselect={() => onchange(source.tool)}>{source.label}</MenuItem
    >
  {/each}
</DropdownMenu>

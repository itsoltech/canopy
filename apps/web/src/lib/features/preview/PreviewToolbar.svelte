<script lang="ts">
  import { create } from "@bufbuild/protobuf";
  import {
    AgentPreviewInputSchema,
    AgentTool,
    type AgentPreviewInput,
    type AgentPreviewTarget,
  } from "@canopy/contracts";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import Select from "#lib/shared/ui/Select.svelte";
  import DropdownMenu from "#lib/shared/ui/DropdownMenu.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import MenuItem from "#lib/shared/ui/MenuItem.svelte";
  import { tooltip } from "#lib/shared/ui/tooltip.ts";
  import TouchTarget from "#lib/shared/ui/TouchTarget.svelte";
  import type { ClassValue } from "svelte/elements";

  let {
    tool,
    url = "",
    targetId = "",
    targets = [],
    enabled,
    oninput,
    onselect,
    focusAddress = $bindable<(() => void) | undefined>(),
    class: className,
  }: {
    tool: AgentTool;
    url?: string;
    targetId?: string;
    targets?: AgentPreviewTarget[];
    enabled: boolean;
    oninput: (input: AgentPreviewInput) => void;
    onselect: (target: AgentPreviewTarget) => void;
    focusAddress?: (() => void) | undefined;
    class?: ClassValue;
  } = $props();

  let address = $state("");
  let field = $state<HTMLInputElement>();
  let editing = $state(false);
  let addressError = $state("");

  $effect(() => {
    if (!editing) address = url;
  });

  $effect(() => {
    focusAddress = () => {
      field?.focus();
      field?.select();
    };
  });

  const send = (kind: string, text = "") => oninput(create(AgentPreviewInputSchema, { kind, text }));

  function navigate(): void {
    const input = address.trim();

    if (!input) return;

    try {
      const base = input.startsWith("/") || input.startsWith(".") || input.startsWith("?") || input.startsWith("#");
      const local = /^(localhost|127\.|0\.|\[::1\]|\d{1,3}(\.\d{1,3}){3})(:|\/|$)/.test(input);
      const explicit = /^[a-z][a-z\d+.-]*:\/\//i.test(input) || input === "about:blank";

      const destination = new URL(
        base ? input : explicit ? input : `${local ? "http" : "https"}://${input}`,
        base ? url : undefined,
      );

      if (!["http:", "https:"].includes(destination.protocol) && destination.href !== "about:blank") throw new Error();
      addressError = "";
      address = destination.href;
      send("navigate", destination.href);
      field?.blur();
    } catch {
      addressError = "Enter a valid page address.";
      field?.focus();
    }
  }
</script>

<div class={["flex min-w-0 items-center gap-1", className]}>
  {#if tool === AgentTool.BROWSER}
    <IconButton size="sm" icon="chevron-left" label="Back" disabled={!enabled} onclick={() => send("back")} />
    <IconButton size="sm" icon="chevron-right" label="Forward" disabled={!enabled} onclick={() => send("forward")} />
    <IconButton size="sm" icon="arrow-path" label="Reload page" disabled={!enabled} onclick={() => send("reload")} />
    <form
      class="min-w-0 flex-1"
      onsubmit={(event) => {
        event.preventDefault();
        navigate();
      }}
    >
      <input
        bind:this={field}
        bind:value={address}
        aria-label="Page address"
        aria-invalid={Boolean(addressError) || undefined}
        title={addressError || url}
        placeholder="Enter a URL"
        disabled={!enabled}
        autocomplete="off"
        autocapitalize="off"
        spellcheck="false"
        onfocus={() => (editing = true)}
        oninput={() => (addressError = "")}
        onblur={() => (editing = false)}
        class="h-8 w-full min-w-0 rounded-md border border-divider bg-panel px-2.5 text-(length:--type-compact) text-ink outline-none disabled:opacity-50 sm:h-7 field-focus:border-brand-500 field-focus:ring-2 field-focus:ring-brand-500/15"
      />
      <span class="sr-only" role="status">{addressError}</span>
    </form>
    {#if targets.length > 1}
      <DropdownMenu label="Browser tabs" placement="bottom-end">
        {#snippet trigger(props)}
          <button
            type="button"
            class="relative inline-flex h-8 shrink-0 items-center gap-1 rounded-md px-1.5 text-xs font-medium text-zinc-600 tabular-nums focus-ring not-disabled:hover:bg-zinc-950/5 disabled:opacity-50 aria-expanded:bg-zinc-950/5 sm:h-7 dark:text-zinc-400 dark:not-disabled:hover:bg-white/10 dark:aria-expanded:bg-white/10"
            aria-label={`Browser tabs: ${targets.length} open`}
            disabled={!enabled}
            {...props}
            {@attach tooltip(`${targets.length} tabs open`)}
          >
            <Icon name="queue-list" />{targets.length}
            <TouchTarget />
          </button>
        {/snippet}
        {#each targets as target (target.id)}
          <MenuItem current={target.id === targetId} onselect={() => onselect(target)}>{target.label}</MenuItem>
        {/each}
      </DropdownMenu>
    {/if}
  {:else}
    <div class="flex min-w-0 flex-1 [&_[role=combobox]]:max-w-full">
      <Select
        inline="muted"
        aria-label={tool === AgentTool.DEVICE ? "Device" : "Window"}
        value={targetId}
        placeholder={tool === AgentTool.DEVICE ? "Choose a device" : "Choose a window"}
        options={targets.map((target) => ({
          value: target.id,
          label: target.label,
          description: target.platform || target.app,
        }))}
        onchange={(id) => {
          const target = targets.find((entry) => entry.id === id);
          if (target) onselect(target);
        }}
      />
    </div>
    {#if tool === AgentTool.DEVICE}<IconButton
        size="sm"
        icon="square"
        label="Device home"
        disabled={!enabled}
        onclick={() => send("home")}
      />{/if}
  {/if}
</div>

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

  let {
    tool,
    url = "",
    targetId = "",
    targets = [],
    enabled,
    oninput,
    onselect,
    focusAddress = $bindable<(() => void) | undefined>(),
  }: {
    tool: AgentTool;
    url?: string;
    targetId?: string;
    targets?: AgentPreviewTarget[];
    enabled: boolean;
    oninput: (input: AgentPreviewInput) => void;
    onselect: (target: AgentPreviewTarget) => void;
    focusAddress?: (() => void) | undefined;
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

<div class="flex min-h-11 shrink-0 items-center gap-1 border-b border-divider px-2">
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
        class="h-8 w-full min-w-0 rounded-md border border-divider bg-panel px-2.5 text-(length:--type-compact) text-ink outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/15 disabled:opacity-50"
      />
      <span class="sr-only" role="status">{addressError}</span>
    </form>
  {:else}
    <div class="min-w-0 flex-1 [&_[role=combobox]]:w-full">
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

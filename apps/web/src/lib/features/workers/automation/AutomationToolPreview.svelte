<script lang="ts">
  import { onDestroy, onMount, untrack } from "svelte";
  import { create } from "@bufbuild/protobuf";
  import { RunAgentToolSchema, type AgentToolOutput, type RunAgentTool } from "@canopy/contracts";
  import Button from "#lib/shared/ui/Button.svelte";
  import Switch from "#lib/shared/ui/Switch.svelte";

  let {
    command,
    enabled,
    busy,
    failed,
    oncapture,
  }: {
    command: RunAgentTool;
    enabled: boolean;
    busy: boolean;
    failed: boolean;
    oncapture: (command: RunAgentTool, signal?: AbortSignal) => Promise<AgentToolOutput | undefined>;
  } = $props();

  let element: HTMLDivElement;
  let imageUrl = $state("");
  let autoRefresh = $state(false);
  let visible = $state(false);
  let foreground = $state(false);
  let connected = $state(false);
  let capturing = $state(false);
  let stopped = $state(false);
  let controller: AbortController | undefined;
  let destroyed = false;
  const active = $derived(enabled && visible && foreground && connected);

  $effect(() => {
    [command.session, command.app, command.windowId, command.deviceId, command.platform].join("/");
    untrack(() => {
      controller?.abort();
      autoRefresh = false;
      stopped = false;

      if (imageUrl) URL.revokeObjectURL(imageUrl);
      imageUrl = "";
    });
  });

  onMount(() => {
    const sync = () => {
      foreground = document.visibilityState === "visible";
      connected = navigator.onLine;
    };

    const observer = new IntersectionObserver(([entry]) => {
      visible = Boolean(entry?.isIntersecting);
    });

    observer.observe(element);
    document.addEventListener("visibilitychange", sync);
    window.addEventListener("online", sync);
    window.addEventListener("offline", sync);
    sync();

    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", sync);
      window.removeEventListener("online", sync);
      window.removeEventListener("offline", sync);
    };
  });

  $effect(() => {
    if (!active) controller?.abort();

    if (!enabled || !connected || failed) autoRefresh = false;
  });

  $effect(() => {
    if (!autoRefresh || !active || busy || capturing) return;
    const timer = setTimeout(() => void capture(), imageUrl ? 3000 : 0);

    return () => clearTimeout(timer);
  });

  onDestroy(() => {
    destroyed = true;
    controller?.abort();

    if (imageUrl) URL.revokeObjectURL(imageUrl);
  });

  async function capture() {
    if (!active || busy || capturing || destroyed) return;
    const current = new AbortController();
    controller = current;
    capturing = true;
    stopped = false;

    const result = await oncapture(
      create(RunAgentToolSchema, { ...command, operation: "screenshot", target: "", value: "" }),
      current.signal,
    );

    if (!destroyed && !current.signal.aborted) {
      if (result?.data.length) {
        const previous = imageUrl;
        imageUrl = URL.createObjectURL(
          new Blob([new Uint8Array(result.data)], { type: result.mimeType || "image/png" }),
        );

        if (previous) URL.revokeObjectURL(previous);
      } else {
        autoRefresh = false;
        stopped = true;
      }
    }

    if (controller === current) controller = undefined;
    capturing = false;
  }
</script>

<div bind:this={element} class="grid min-w-0 gap-2">
  <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
    <Button size="sm" disabled={!active || busy} loading={capturing} onclick={() => void capture()}
      >Take screenshot</Button
    >
    <div class="flex items-center gap-2">
      <span class="text-sm/5 text-zinc-700 dark:text-zinc-300">Auto-refresh</span>
      <Switch
        name="automation-preview-refresh"
        label="Auto-refresh"
        bind:checked={autoRefresh}
        disabled={!enabled || !connected}
        onchange={() => {
          stopped = false;
        }}
      />
    </div>
  </div>
  <div
    class="flex min-h-40 items-center justify-center overflow-hidden rounded-lg border border-zinc-950/10 bg-zinc-950/2.5 dark:border-white/10 dark:bg-white/3"
  >
    {#if imageUrl}
      <img
        class="max-h-96 max-w-full object-contain"
        src={imageUrl}
        alt="Latest screenshot from the selected automation tool"
      />
    {:else}
      <p class="px-4 py-6 text-center text-sm/5 text-zinc-500 dark:text-zinc-400">
        Take a screenshot to inspect the screen.
      </p>
    {/if}
  </div>
  <p class="min-h-5 text-sm/5 text-zinc-500 dark:text-zinc-400" role="status">
    {stopped
      ? "Preview stopped. Take another screenshot to retry."
      : autoRefresh
        ? active
          ? "Refreshes every 3 seconds while visible."
          : "Preview paused while hidden."
        : "Auto-refresh takes screenshots while this preview is visible."}
  </p>
</div>

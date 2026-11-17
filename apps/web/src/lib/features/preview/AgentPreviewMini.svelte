<script lang="ts">
  import { onMount, tick, untrack } from "svelte";
  import { AgentTool, type AgentPreviewTarget, type ui } from "@canopy/contracts";
  import Button from "#lib/shared/ui/Button.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import Spinner from "#lib/shared/ui/Spinner.svelte";
  import TruncatedText from "#lib/shared/ui/TruncatedText.svelte";
  import { previewScope, previewScopeKey } from "./preview-client.ts";
  import { paintPreviewFrame } from "./preview-frame.ts";
  import { isPreviewReady } from "./preview-readiness.ts";
  import { PreviewSession } from "./preview-session.svelte.ts";

  /**
   * Passive watch beneath the thread summary. The parent owns activity, placement and sidebar handoff;
   * `active` must be false while the sidebar preview is open. `onminimize` toggles both minimize and restore.
   * Page visibility, intersection, online state and access gate the stream. Effect cleanup aborts the watch
   * and discards its frame on every scope change or unmount; object URLs and observers are disposed separately.
   */
  let {
    threadId,
    worker,
    tool,
    target,
    active,
    minimized,
    onminimize,
    onexpand,
    offline = "",
  }: {
    threadId: string;
    worker?: ui.Worker;
    tool: AgentTool;
    target?: AgentPreviewTarget;
    active: boolean;
    minimized: boolean;
    onminimize: () => void;
    onexpand: (target?: AgentPreviewTarget) => void;
    offline?: string;
  } = $props();

  const session = new PreviewSession();
  let root = $state<HTMLElement>();
  let foreground = $state(false);
  let visible = $state(false);
  let connected = $state(false);
  let canvas = $state<HTMLCanvasElement>();
  let retry = $state(0);
  let stopWatch: (() => void) | undefined;
  let watchedScope = "";
  const name = $derived(tool === AgentTool.BROWSER ? "Browser" : tool === AgentTool.DEVICE ? "Device" : "Desktop");

  const icon = $derived(
    tool === AgentTool.BROWSER ? "globe-alt" : tool === AgentTool.DEVICE ? "square" : "computer-desktop",
  );

  const caption = $derived(target?.label || session.title);
  const workerId = $derived(worker?.id ?? "");
  const scopeKey = $derived(previewScopeKey(threadId, workerId, tool, target));
  const item = $derived(worker?.agentTools.find((entry) => entry.tool?.tool === tool));
  const ready = $derived(isPreviewReady(item?.tool));
  const installing = $derived(item?.tool?.install?.state === "running");
  const unavailable = $derived(Boolean(offline || !connected || !worker?.online));
  const allowed = $derived(!unavailable && Boolean(item?.enabled && ready && !item.blockedReason));
  const watching = $derived(active && !minimized && foreground && visible && allowed);
  const failed = $derived(["error", "closed"].includes(session.state));

  const status = $derived.by(() => {
    if (offline || !worker?.online) return { title: "Computer offline", detail: "Reconnect this computer to resume." };

    if (!connected) return { title: "You’re offline", detail: "Reconnect to resume this preview." };

    if (installing) return { title: "Installing tool…", detail: "Preview starts when installation finishes." };

    if (!ready) return { title: "Tool not ready", detail: "Open Preview to check this tool." };

    if (item?.blockedReason)
      return { title: "Preview unavailable", detail: "Open Preview to check access and tool status." };

    if (!item?.enabled) return { title: "Access needed", detail: "Open Preview to allow agent access." };

    if (!watching) return { title: "Preview paused", detail: "Open Preview to watch this tool." };

    if (failed) return { title: "Preview disconnected", detail: "Check the connection, then retry." };

    if (session.state === "ready" && !session.frame && tool !== AgentTool.BROWSER && !session.targetId)
      return {
        title: "Choose a target",
        detail: tool === AgentTool.DEVICE ? "Open Preview to choose a device." : "Open Preview to choose a window.",
      };

    return {
      title: session.state === "connecting" ? "Connecting…" : "Waiting for image…",
      detail: "",
    };
  });

  onMount(() => {
    const sync = () => {
      foreground = document.visibilityState === "visible";
      connected = navigator.onLine;
    };

    const observer = new IntersectionObserver(([entry]) => (visible = Boolean(entry?.isIntersecting)));

    if (root) observer.observe(root);
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
    const key = scopeKey;
    void retry;

    if (!watching) return;
    watchedScope = key;
    const stop = untrack(() => session.connect(threadId, previewScope(tool, target), 4));
    stopWatch = stop;

    return () => {
      stop();

      if (stopWatch === stop) stopWatch = undefined;
    };
  });

  $effect(() => {
    const frame = session.frame;
    const surface = canvas;

    if (!frame?.data.length || !surface) return;

    return paintPreviewFrame(
      surface,
      frame,
      (value) => session.painted(value),
      (value) => session.frameError(value),
    );
  });

  function handoff(action: () => void): void {
    stopWatch?.();
    stopWatch = undefined;
    action();
  }

  function expand(): void {
    const selected =
      watchedScope === scopeKey ? (session.targets.find((entry) => entry.id === session.targetId) ?? target) : target;

    handoff(() => onexpand(selected));
  }

  async function toggle(): Promise<void> {
    const focused = root?.querySelector("[data-preview-toggle]") === document.activeElement;
    handoff(onminimize);
    await tick();

    if (focused) root?.querySelector<HTMLButtonElement>("[data-preview-toggle]")?.focus({ preventScroll: true });
  }
</script>

<section
  bind:this={root}
  aria-label={`${name} preview`}
  class="density-chrome pointer-events-auto flex max-h-[45dvh] w-80 max-w-full flex-col overflow-hidden rounded-xl bg-surface text-ink shadow-sm ring-1 ring-divider dark:shadow-none"
>
  <div
    class="flex h-10 shrink-0 items-center gap-2 border-b border-divider pr-1.5 pl-3 sm:h-9"
    class:border-transparent={minimized}
  >
    <Icon name={icon} />
    <span class="shrink-0 text-sm/5 font-medium">{name}</span>
    <div class="min-w-0 flex-1 text-sm/5 text-muted sm:text-xs/5">
      {#if !minimized}<TruncatedText text={caption} />{/if}
    </div>
    <div class="flex shrink-0 items-center gap-1">
      <IconButton
        size="sm"
        icon="chevron-down"
        iconClass={minimized ? "rotate-180" : undefined}
        label={minimized ? "Restore preview" : "Minimize preview"}
        aria-expanded={!minimized}
        data-preview-toggle
        onclick={() => void toggle()}
      />
      <IconButton size="sm" icon="arrow-top-right-on-square" label="Open in sidebar" onclick={expand} />
    </div>
  </div>
  {#if !minimized}
    <div class="relative aspect-2/1 max-h-40 min-h-0 overflow-hidden bg-panel">
      {#if session.frame && watching && !failed}
        <canvas bind:this={canvas} aria-label={`Live ${name} preview`} class="size-full object-contain"></canvas>
      {:else}
        <div class="absolute inset-0 flex flex-col items-center justify-center gap-1.5 px-5 text-center" role="status">
          {#if watching && !failed && !status.detail}<Spinner class="mb-1 text-muted" />{/if}
          <p class="text-sm/5 font-medium">{status.title}</p>
          {#if status.detail}<p class="max-w-60 text-sm/5 text-muted sm:text-xs/5">{status.detail}</p>{/if}
          {#if watching && failed}<div class="mt-1">
              <Button size="sm" icon="arrow-path" onclick={() => retry++}>Retry preview</Button>
            </div>{/if}
        </div>
      {/if}
    </div>
  {/if}
</section>

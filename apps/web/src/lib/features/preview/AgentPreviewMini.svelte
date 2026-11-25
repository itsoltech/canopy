<script lang="ts">
  import { onMount, tick, untrack } from "svelte";
  import { AgentTool, type AgentPreviewTarget, type ui } from "@canopy/contracts";
  import Button from "#lib/shared/ui/Button.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import Spinner from "#lib/shared/ui/Spinner.svelte";
  import TruncatedText from "#lib/shared/ui/TruncatedText.svelte";
  import { previewScope, previewScopeKey } from "./preview-client.ts";
  import PreviewFrame from "./PreviewFrame.svelte";
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
    activityId,
    settled,
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
    activityId: string;
    settled: boolean;
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
  let retry = $state(0);
  let stopWatch: (() => void) | undefined;
  let watchedScope = $state("");
  const name = $derived(tool === AgentTool.BROWSER ? "Browser" : tool === AgentTool.DEVICE ? "Device" : "Desktop");

  const icon = $derived(
    tool === AgentTool.BROWSER ? "globe-alt" : tool === AgentTool.DEVICE ? "square" : "computer-desktop",
  );

  const followAgent = $derived(tool === AgentTool.DESKTOP);
  const workerId = $derived(worker?.id ?? "");
  const scopeKey = $derived(previewScopeKey(threadId, workerId, tool, target, followAgent));
  const item = $derived(worker?.agentTools.find((entry) => entry.tool?.tool === tool));
  const ready = $derived(isPreviewReady(item?.tool));
  const installing = $derived(item?.tool?.install?.state === "running");
  const unavailable = $derived(Boolean(offline || !connected || !worker?.online));
  const allowed = $derived(!unavailable && Boolean(item?.enabled && ready && !item.blockedReason));
  const watching = $derived(active && !minimized && foreground && visible && allowed);
  const failed = $derived(["error", "closed", "unconfirmed"].includes(session.state));
  const currentSession = $derived(watchedScope === scopeKey ? session : undefined);
  const frame = $derived(watching ? currentSession?.frame : undefined);
  const lastImage = $derived(settled && frame?.agentObservation);

  const caption = $derived(
    followAgent ? (frame?.title ?? "") : target?.label || frame?.title || currentSession?.title || "",
  );

  const source = $derived(followAgent ? frame : currentSession);
  const selected = $derived(source?.targets.find((entry) => entry.id === source.targetId));
  const canExpand = $derived(!followAgent || !frame || Boolean(frame.targetId && selected));

  const status = $derived.by(() => {
    if (offline || !worker?.online) return { title: "Computer offline", detail: "Reconnect this computer to resume." };

    if (!connected) return { title: "You’re offline", detail: "Reconnect to resume this preview." };

    if (installing) return { title: "Installing tool…", detail: "" };

    if (!ready) return { title: "Tool not ready", detail: "Open Preview to check this tool." };

    if (item?.blockedReason)
      return { title: "Preview unavailable", detail: "Open Preview to check access and tool status." };

    if (!item?.enabled) return { title: "Access needed", detail: "Open Preview to allow agent access." };

    if (!watching) return { title: "Preview paused", detail: "Open Preview to watch this tool." };

    if (session.state === "unconfirmed") return { title: "Agent view unavailable", detail: session.detail };

    if (failed) return { title: "Preview disconnected", detail: "Check the connection, then retry." };

    if (settled) return { title: "Preview paused", detail: "" };

    if (session.state === "ready" && !frame) {
      if (followAgent) return { title: "Waiting for the agent’s view…", detail: "" };

      if (tool === AgentTool.DEVICE && !session.targetId)
        return { title: "Choose a target", detail: "Open Preview to choose a device." };
    }

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

    const observer = new IntersectionObserver((entries) => (visible = Boolean(entries.at(-1)?.isIntersecting)));

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

    const stop = untrack(() =>
      session.connect(threadId, previewScope(tool, target), { maxFps: followAgent ? 12 : 4, followAgent }),
    );

    stopWatch = stop;

    return () => {
      stop();

      if (stopWatch === stop) stopWatch = undefined;
    };
  });

  $effect.pre(() => {
    const id = activityId;
    const paused = settled;
    untrack(() => session.images.activity(id, paused));
  });

  function handoff(action: () => void): void {
    stopWatch?.();
    stopWatch = undefined;
    action();
  }

  function expand(): void {
    if (!canExpand) return;
    const destination = selected ?? target;
    handoff(() => onexpand(destination));
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
    <div class="flex min-w-0 flex-1 gap-1 text-sm/5 text-muted sm:text-xs/5">
      {#if !minimized}
        {#if lastImage}<span class="shrink-0">Last view{caption ? " ·" : ""}</span>{/if}
        <TruncatedText text={caption} />
      {/if}
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
      <IconButton
        size="sm"
        icon="arrow-top-right-on-square"
        label="Open in sidebar"
        disabled={!canExpand}
        onclick={expand}
      />
    </div>
  </div>
  {#if !minimized}
    <div
      class="[container-type:size] relative grid aspect-2/1 max-h-40 min-h-0 place-items-center overflow-hidden bg-panel"
    >
      {#if frame}
        <div
          class="relative"
          style:width={`min(100cqw, ${(100 * frame.width) / frame.height}cqh)`}
          style:aspect-ratio={`${frame.width} / ${frame.height}`}
        >
          {#key frame.agentObservation ? frame : frame.targetId}
            <PreviewFrame
              {frame}
              aria-label={lastImage
                ? `Last ${name} view`
                : frame.agentObservation
                  ? "Agent screenshot"
                  : `Live ${name} preview`}
              class="block size-full"
              onpaint={(painted) => session.painted(painted)}
              onframeerror={(failedFrame) => session.frameError(failedFrame)}
            />
          {/key}
        </div>
      {:else}
        <div class="absolute inset-0 flex flex-col items-center justify-center gap-1.5 px-5 text-center" role="status">
          {#if watching && !settled && !failed && !status.detail}<Spinner class="mb-1 text-muted" />{/if}
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

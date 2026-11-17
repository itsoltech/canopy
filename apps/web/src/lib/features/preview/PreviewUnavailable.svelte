<script lang="ts">
  import { create } from "@bufbuild/protobuf";
  import { AgentTool, ui } from "@canopy/contracts";
  import Button from "#lib/shared/ui/Button.svelte";
  import ButtonLink from "#lib/shared/ui/ButtonLink.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import { requestJson } from "#lib/shared/http.ts";
  import { encode } from "#lib/shared/wire.ts";
  import { isPreviewReady } from "./preview-readiness.ts";

  let {
    worker,
    tool,
    item,
    offline = "",
  }: { worker?: ui.Worker; tool: AgentTool; item?: ui.WorkerAgentTool; offline?: string } = $props();

  let busy = $state(false);
  let error = $state("");
  const installing = $derived(item?.tool?.install?.state === "running");
  const ready = $derived(isPreviewReady(item?.tool));

  const title = $derived(
    offline
      ? "Computer offline"
      : installing
        ? "Installing automation tool…"
        : !item?.tool
          ? "Check automation tools"
          : item.blockedReason
            ? "Preview unavailable"
            : !ready
              ? "Set up this preview"
              : "Enable this preview",
  );

  const description = $derived(
    offline ||
      item?.blockedReason ||
      (!item?.tool
        ? "Check this computer to find available automation tools."
        : !ready
          ? item.tool.detail || "Install the tool on this computer to open a live preview."
          : "Allow agent access to view and control previews in this thread."),
  );

  async function action(): Promise<void> {
    if (!worker || busy) return;
    busy = true;
    error = "";
    const kind = !item?.tool ? "refresh" : !ready ? "install" : "enable";

    const body =
      kind === "refresh"
        ? encode(ui.RefreshAgentToolsRequestSchema, create(ui.RefreshAgentToolsRequestSchema, { workerId: worker.id }))
        : kind === "install"
          ? encode(
              ui.InstallAgentToolRequestSchema,
              create(ui.InstallAgentToolRequestSchema, {
                workerId: worker.id,
                tool,
                installRuntime: tool === AgentTool.BROWSER,
              }),
            )
          : encode(
              ui.SetAgentToolEnabledRequestSchema,
              create(ui.SetAgentToolEnabledRequestSchema, { workerId: worker.id, tool, enabled: true }),
            );

    try {
      await requestJson("POST", `/api/workers/agent-tools/${kind}`, body);
    } catch {
      error = "Could not update this tool. Check its status in Settings, then retry.";
    } finally {
      busy = false;
    }
  }
</script>

<div class="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 py-8 text-center">
  <span class="rounded-xl bg-panel p-3"
    ><Icon name={offline ? "signal-slash" : "computer-desktop"} class="size-6" /></span
  >
  <div class="max-w-72">
    <p class="text-sm/5 font-medium text-ink">{title}</p>
    <p class="mt-1 text-sm/5 text-muted">{description}</p>
  </div>
  {#if !offline && !item?.blockedReason && (!item?.tool || ready || item.action)}
    <Button size="sm" loading={busy || installing} disabled={installing || !worker} onclick={() => void action()}
      >{!item?.tool ? "Check tools" : ready ? "Allow agent access" : "Install tool"}</Button
    >
  {/if}
  {#if worker && !offline && (item?.blockedReason || (item?.tool && !ready && !item.action))}<ButtonLink
      size="sm"
      href="/settings/agent-tools">Open tool settings</ButtonLink
    >{/if}
  {#if error}<p class="max-w-72 text-sm/5 text-rose-700 dark:text-rose-400" role="alert">{error}</p>{/if}
</div>

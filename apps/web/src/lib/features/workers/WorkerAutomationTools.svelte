<script lang="ts">
  import { onDestroy } from "svelte";
  import { create, type DescMessage, type MessageInitShape, type MessageShape } from "@bufbuild/protobuf";
  import { AgentTool, ui } from "@canopy/contracts";
  import Button from "#lib/shared/ui/Button.svelte";
  import CodeBlock from "#lib/shared/ui/CodeBlock.svelte";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";
  import Field from "#lib/shared/ui/Field.svelte";
  import Select from "#lib/shared/ui/Select.svelte";
  import ActionNote from "./ActionNote.svelte";
  import AutomationToolStatus from "./automation/AutomationToolStatus.svelte";
  import WorkerSection from "./WorkerSection.svelte";
  import { requestJson } from "#lib/shared/http.ts";
  import { decode, encode } from "#lib/shared/wire.ts";

  let { worker, readOnly = "" }: { worker: ui.Worker; readOnly?: string } = $props();
  let pending = $state("");
  let error = $state("");
  let detail = $state("");
  let note = $state("");
  let selected = $state(String(AgentTool.BROWSER));
  let controller: AbortController | undefined;
  let destroyed = false;

  const label = (tool: AgentTool): string =>
    tool === AgentTool.BROWSER ? "agent-browser" : tool === AgentTool.DESKTOP ? "agent-desktop" : "agent-device";

  const available = $derived(worker.agentTools.filter((item) => item.tool && item.tool.tool !== AgentTool.UNSPECIFIED));
  const item = $derived(available.find((entry) => String(entry.tool?.tool) === selected) ?? available[0]);
  const online = $derived(worker.online && !readOnly);
  const disabled = $derived(!online || Boolean(pending));

  $effect(() => {
    if (!online) controller?.abort();
  });

  onDestroy(() => {
    destroyed = true;
    controller?.abort();
  });

  async function refresh() {
    const result = await request(
      "refresh",
      "check tools",
      ui.RefreshAgentToolsRequestSchema,
      ui.RefreshAgentToolsResponseSchema,
      { workerId: worker.id },
    );

    if (result)
      note = result.skipped.length
        ? "Some tools could not be checked. Check the worker, then retry."
        : "Tool check complete.";

    if (result?.skipped.length) detail = result.skipped.join("\n");
  }

  async function install(tool: AgentTool) {
    const result = await request(
      "install",
      "start the install",
      ui.InstallAgentToolRequestSchema,
      ui.InstallAgentToolResponseSchema,
      {
        workerId: worker.id,
        tool,
        installRuntime: tool === AgentTool.BROWSER,
      },
    );

    if (result) note = "Install started. Follow its progress in the install log.";
  }

  async function enable(tool: AgentTool, enabled: boolean) {
    await request(
      "enable",
      "save agent access",
      ui.SetAgentToolEnabledRequestSchema,
      ui.WorkerOperationResponseSchema,
      { workerId: worker.id, tool, enabled },
    );
  }

  async function request<Req extends DescMessage, Res extends DescMessage>(
    action: string,
    description: string,
    requestSchema: Req,
    responseSchema: Res,
    input: MessageInitShape<Req>,
    signal?: AbortSignal,
  ): Promise<MessageShape<Res> | undefined> {
    if (pending || !online || destroyed || signal?.aborted) return;
    const active = new AbortController();
    controller = active;
    pending = action;
    error = "";
    detail = "";
    note = "";

    try {
      const response = await requestJson(
        "POST",
        `/api/workers/agent-tools/${action}`,
        encode(requestSchema, create(requestSchema, input)),
        110_000,
        signal ? AbortSignal.any([active.signal, signal]) : active.signal,
      );

      if (!destroyed && !active.signal.aborted && !signal?.aborted) return decode(responseSchema, response);
    } catch (cause) {
      if (!destroyed && !active.signal.aborted && !signal?.aborted) {
        error = `Could not ${description}. Check the tool, then retry.`;
        detail = cause instanceof Error ? cause.message : "The worker did not complete the request.";
      }
    } finally {
      if (controller === active) {
        controller = undefined;
        pending = "";
      }
    }
  }
</script>

<WorkerSection
  title="Automation tools"
  description="Let agents use a browser, desktop or simulator during turns on this worker."
>
  {#snippet actions()}
    <Button size="sm" icon="arrow-path" loading={pending === "refresh"} {disabled} onclick={() => void refresh()}
      >Check tools</Button
    >
  {/snippet}
  {#if available.length}
    <Field label="Active tool">
      <Select
        value={String(item?.tool?.tool)}
        options={available.map((entry) => ({ value: String(entry.tool?.tool), label: label(entry.tool!.tool) }))}
        disabled={Boolean(pending)}
        onchange={(value) => {
          selected = value;
          error = "";
          detail = "";
          note = "";
        }}
      />
    </Field>
    {#if item?.tool}
      <AutomationToolStatus
        {item}
        {disabled}
        installing={pending === "install"}
        saving={pending === "enable"}
        oninstall={() => void install(item.tool!.tool)}
        onenable={(enabled) => void enable(item.tool!.tool, enabled)}
      />
      {#if !worker.online}<p class="text-sm/5 text-zinc-500 dark:text-zinc-400" role="status">
          Worker offline. Reconnect it to use automation tools.
        </p>{/if}
      <p class="text-sm/5 text-zinc-500 dark:text-zinc-400">Open Preview in a thread to view and control its screen.</p>
    {/if}
  {:else}
    <div>
      <p class="text-base/6 font-medium text-zinc-950 sm:text-sm/6 dark:text-white">No tools detected</p>
      <p class="text-sm/5 text-zinc-500 dark:text-zinc-400">Connect an updated worker, then check tools.</p>
    </div>
  {/if}
  <ActionNote {error} {note} />
  {#if detail}
    <Disclosure>
      {#snippet summary()}<span class="text-sm/5 text-zinc-500 dark:text-zinc-400">Show details</span>{/snippet}
      <div class="pt-2"><CodeBlock text={detail} label="Automation request details" /></div>
    </Disclosure>
  {/if}
</WorkerSection>

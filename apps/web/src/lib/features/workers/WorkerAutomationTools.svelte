<script lang="ts">
  import { onDestroy } from "svelte";
  import { create, type DescMessage, type MessageInitShape, type MessageShape } from "@bufbuild/protobuf";
  import { AgentTool, RunAgentToolSchema, ui, type RunAgentTool } from "@canopy/contracts";
  import Button from "#lib/shared/ui/Button.svelte";
  import CodeBlock from "#lib/shared/ui/CodeBlock.svelte";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";
  import Field from "#lib/shared/ui/Field.svelte";
  import Select from "#lib/shared/ui/Select.svelte";
  import ActionNote from "./ActionNote.svelte";
  import AutomationToolStatus from "./automation/AutomationToolStatus.svelte";
  import AutomationToolControls from "./automation/AutomationToolControls.svelte";
  import WorkerSection from "./WorkerSection.svelte";
  import { requestJson } from "#lib/shared/http.ts";
  import { decode, encode } from "#lib/shared/wire.ts";

  let { worker, readOnly = "" }: { worker: ui.Worker; readOnly?: string } = $props();
  let pending = $state("");
  let error = $state("");
  let detail = $state("");
  let note = $state("");
  let selected = $state(String(AgentTool.BROWSER));
  let drafts = $state<Record<string, { command: RunAgentTool; destination: string }>>({});
  let controller: AbortController | undefined;
  let destroyed = false;

  const label = (tool: AgentTool): string =>
    tool === AgentTool.BROWSER ? "agent-browser" : tool === AgentTool.DESKTOP ? "agent-desktop" : "agent-device";

  const available = $derived(worker.agentTools.filter((item) => item.tool && item.tool.tool !== AgentTool.UNSPECIFIED));
  const item = $derived(available.find((entry) => String(entry.tool?.tool) === selected) ?? available[0]);
  const draft = $derived(item?.tool ? drafts[`${worker.id}/${item.tool.tool}`] : undefined);
  const online = $derived(worker.online && !readOnly);
  const disabled = $derived(!online || Boolean(pending));

  $effect(() => {
    for (const entry of available) {
      const tool = entry.tool;
      const key = `${worker.id}/${tool?.tool}`;

      if (tool && !drafts[key])
        drafts[key] = { command: create(RunAgentToolSchema, { tool: tool.tool, operation: "click" }), destination: "" };
    }
  });

  $effect(() => {
    if (!online || (pending === "run" && !item?.enabled)) controller?.abort();
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

  async function run(operation: RunAgentTool, signal?: AbortSignal) {
    const result = await request(
      "run",
      "run the tool",
      ui.RunAgentToolRequestSchema,
      ui.RunAgentToolResponseSchema,
      { workerId: worker.id, operation },
      signal,
    );

    return result?.result;
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
      {#if item.tool.ready && !item.enabled}<p class="text-sm/5 text-zinc-500 dark:text-zinc-400">
          Turn on Allow agent access to use manual controls.
        </p>{/if}
      {#if item.tool.ready && draft}
        {#key `${worker.id}/${item.tool.tool}`}
          <AutomationToolControls
            bind:command={draft.command}
            bind:destination={draft.destination}
            tool={item.tool}
            online={online && item.enabled && !item.blockedReason}
            busy={Boolean(pending)}
            failed={Boolean(error)}
            onrun={run}
          />
        {/key}
      {/if}
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

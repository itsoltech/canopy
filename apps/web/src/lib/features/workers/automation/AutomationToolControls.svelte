<script lang="ts">
  import { create } from "@bufbuild/protobuf";
  import {
    AgentTool,
    RunAgentToolSchema,
    type AgentToolInfo,
    type AgentToolOutput,
    type RunAgentTool,
  } from "@canopy/contracts";
  import Button from "#lib/shared/ui/Button.svelte";
  import CodeBlock from "#lib/shared/ui/CodeBlock.svelte";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";
  import Field from "#lib/shared/ui/Field.svelte";
  import Input from "#lib/shared/ui/Input.svelte";
  import Select from "#lib/shared/ui/Select.svelte";
  import AutomationToolPreview from "./AutomationToolPreview.svelte";

  let {
    command = $bindable(),
    destination = $bindable(""),
    tool,
    online,
    busy,
    failed,
    onrun,
  }: {
    command: RunAgentTool;
    destination?: string;
    tool: AgentToolInfo;
    online: boolean;
    busy: boolean;
    failed: boolean;
    onrun: (command: RunAgentTool, signal?: AbortSignal) => Promise<AgentToolOutput | undefined>;
  } = $props();

  let output = $state("");
  let completed = $state("");
  const desktop = $derived(tool.tool === AgentTool.DESKTOP);
  const browser = $derived(tool.tool === AgentTool.BROWSER);
  const disabled = $derived(!online || busy);
  const device = $derived(tool.tool === AgentTool.DEVICE);

  const needsTarget = $derived(
    ["click", "fill"].includes(command.operation) ||
      (command.operation === "type" && !device) ||
      (command.operation === "press" && device),
  );

  const needsValue = $derived(
    ["fill", "type"].includes(command.operation) || (command.operation === "press" && !device),
  );

  const operations = $derived([
    { value: "click", label: "Click element" },
    { value: "fill", label: "Fill field" },
    { value: "type", label: "Type text" },
    { value: "press", label: device ? "Press element" : "Press key" },
    ...(!desktop ? [{ value: "close", label: browser ? "Close browser" : "Close app" }] : []),
  ]);

  $effect(() => {
    if (device && !["ios", "android"].includes(command.platform)) command.deviceId = "";
  });

  async function run(operation: string, target = command.target, value = command.value) {
    completed = "";
    const refAction = desktop && ["click", "fill", "type"].includes(operation);

    const result = await onrun(
      create(RunAgentToolSchema, {
        ...command,
        operation,
        target: device && operation === "type" ? "" : target,
        value: ["fill", "type"].includes(operation) || (operation === "press" && !device) ? value : "",
        ...(refAction && { app: "", windowId: "" }),
      }),
    );

    if (result) {
      output = result.text;
      completed = "Action complete";
    }
  }
</script>

<div class="grid min-w-0 gap-4 border-t border-zinc-950/5 pt-4 dark:border-white/10">
  <div>
    <p class="text-base/6 font-medium text-zinc-950 sm:text-sm/6 dark:text-white">Manual controls</p>
    <p class="text-sm/5 text-zinc-500 dark:text-zinc-400">Inspect the screen and try actions on this worker.</p>
  </div>
  <Disclosure>
    {#snippet summary()}<span class="text-sm/5 font-medium text-zinc-700 dark:text-zinc-300"
        >Choose session{desktop ? " and window" : !browser ? " and device" : ""}</span
      >{/snippet}
    <div class="grid gap-3 pt-3 sm:grid-cols-2">
      <Field
        label="Session"
        description="Use a Canopy thread ID to inspect an agent session, or leave blank for the default."
        optional
      >
        <Input bind:value={command.session} placeholder="default" {disabled} />
      </Field>
      {#if desktop}
        <Field label="Application" description="Use the app name or bundle ID." optional
          ><Input bind:value={command.app} placeholder="com.apple.finder" {disabled} /></Field
        >
        <Field label="Window ID" description="Limit screenshots and element reads to this window." optional
          ><Input bind:value={command.windowId} placeholder="1234" {disabled} /></Field
        >
      {:else if !browser}
        <Field label="Device ID" description="Choose iOS or Android to target a specific device." optional
          ><Input
            bind:value={command.deviceId}
            placeholder="emulator-5554"
            disabled={disabled || !["ios", "android"].includes(command.platform)}
          /></Field
        >
      {/if}
    </div>
  </Disclosure>
  {#if !browser && !desktop}
    <Field label="Platform">
      <Select
        bind:value={command.platform}
        {disabled}
        options={[
          { value: "", label: "Automatic" },
          { value: "ios", label: "iOS" },
          { value: "android", label: "Android" },
          { value: "web", label: "Web" },
        ]}
      />
    </Field>
  {/if}
  {#if !desktop}
    <form
      class="grid items-end gap-2 sm:grid-cols-[1fr_auto]"
      onsubmit={(event) => {
        event.preventDefault();
        void run("open", destination, "");
      }}
    >
      <Field label={browser ? "Page URL" : "App or URL"}>
        <Input
          bind:value={destination}
          placeholder={browser ? "https://example.com" : "com.example.app"}
          {disabled}
          required
        />
      </Field>
      <div>
        <Button type="submit" disabled={disabled || !destination.trim()}>{browser ? "Open page" : "Open app"}</Button>
      </div>
    </form>
  {/if}
  {#if tool.screenshot}<AutomationToolPreview {command} enabled={online} {busy} {failed} oncapture={onrun} />{/if}
  <div class="flex flex-wrap items-center gap-2">
    <Button size="sm" {disabled} onclick={() => void run("snapshot", "", "")}>Read elements</Button>
    <p class="text-sm/5 text-zinc-500 dark:text-zinc-400">Read element references before clicking or filling fields.</p>
  </div>
  <form
    class="grid gap-3"
    onsubmit={(event) => {
      event.preventDefault();
      void run(
        command.operation,
        command.operation === "press" && !device ? "" : command.operation === "close" ? destination : command.target,
      );
    }}
  >
    <div class="grid gap-3 sm:grid-cols-2">
      <Field label="Action"><Select bind:value={command.operation} options={operations} {disabled} /></Field>
      {#if needsTarget}<Field
          label="Element reference"
          description={desktop ? "Use the full window reference from Read elements." : undefined}
          ><Input bind:value={command.target} placeholder={desktop ? "@w1:e1" : "@e1"} {disabled} required /></Field
        >{/if}
      {#if needsValue}<Field label={command.operation === "press" ? "Key or shortcut" : "Text"}
          ><Input
            bind:value={command.value}
            placeholder={command.operation === "press" ? "Enter" : "Hello"}
            {disabled}
            required={command.operation !== "fill"}
          /></Field
        >{/if}
    </div>
    <div class="flex flex-wrap items-center gap-3">
      <Button type="submit" variant="primary" {disabled}>Run action</Button>
      <span class="text-sm/5 text-zinc-500 dark:text-zinc-400" role="status">{completed}</span>
    </div>
  </form>
  {#if output}<CodeBlock text={output} label="Automation tool output" />{/if}
</div>

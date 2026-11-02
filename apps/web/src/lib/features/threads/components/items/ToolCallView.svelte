<script lang="ts">
  import type { Component } from "svelte";
  import { ItemStatus, type ToolCall } from "@open-agents/contracts";
  import { parseObject } from "#lib/shared/format.ts";
  import SeenImage from "#lib/features/attachments/SeenImage.svelte";
  import { useThreadDirectory } from "../../thread-directory.ts";
  import ItemFrame from "./ItemFrame.svelte";
  import DiffCounts from "./DiffCounts.svelte";
  import { diffCounts, toolChanges } from "./tools/changes.ts";
  import type { ToolBodyProps } from "./tools/body.ts";
  import EditBody from "./tools/EditBody.svelte";
  import GenericBody from "./tools/GenericBody.svelte";
  import MarkdownBody from "./tools/MarkdownBody.svelte";
  import RawToggle from "./tools/RawToggle.svelte";
  import ReadBody from "./tools/ReadBody.svelte";
  import { describeTool, type ToolBody } from "./tools/registry.ts";
  import ScriptBody from "./tools/ScriptBody.svelte";
  import SearchBody from "./tools/SearchBody.svelte";
  import ShellBody from "./tools/ShellBody.svelte";
  import TodoBody from "./tools/TodoBody.svelte";
  import WebBody from "./tools/WebBody.svelte";

  /**
   * Built-in, MCP or dynamic tool, as the registry (tools/registry.ts) describes it: a title in words with
   * its subject and a short detail, and inside a view made for the tool (file lines, matches, diffs, a
   * script's commands) or the generic structured one. The raw input and result stay behind "Show raw".
   * Bodies mount only when the row is open, so highlighting and diffs cost nothing while it is closed.
   */
  let { call, status, streaming = false }: { call: ToolCall; status: ItemStatus; streaming?: boolean } = $props();

  const bodies: Record<ToolBody, Component<ToolBodyProps>> = {
    read: ReadBody,
    search: SearchBody,
    files: SearchBody,
    fetch: WebBody,
    "web-search": WebBody,
    script: ScriptBody,
    todo: TodoBody,
    edit: EditBody,
    patch: EditBody,
    shell: ShellBody,
    markdown: MarkdownBody,
    generic: GenericBody,
  };

  const look = $derived(
    describeTool({ server: call.server, name: call.name, inputJson: call.inputJson, output: call.output, isError: call.isError, running: status === ItemStatus.IN_PROGRESS }),
  );
  const input = $derived(parseObject(call.inputJson));
  const Body = $derived(bodies[look.body]);
  const failed = $derived(call.isError || status === ItemStatus.FAILED);
  const counts = $derived(look.body === "edit" || look.body === "patch" ? diffCounts(toolChanges(call.name, input)) : undefined);
  const directory = useThreadDirectory();
</script>

<ItemFrame icon={look.icon} {status} tone={failed ? "rose" : "neutral"}>
  {#snippet title()}
    <span class="flex min-w-0 gap-1.5">
      <span class="shrink-0 text-zinc-800 dark:text-zinc-200">{look.title}</span>
      {#if look.subject}
        <span class={["truncate text-zinc-500 dark:text-zinc-400", look.mono && "font-mono text-xs"]} title={look.subjectTitle}>{look.subject}</span>
      {/if}
    </span>
  {/snippet}
  {#snippet aside()}
    {#if counts}<DiffCounts {...counts} />{/if}
    {#if look.detail}<span class="max-sm:hidden">{look.detail}</span>{/if}
    {#if call.isError && status !== ItemStatus.FAILED}<span class="text-rose-700 dark:text-rose-400">Error</span>{/if}
  {/snippet}
  <!-- Images in the result (e.g. Read on an image file): what the model saw. -->
  {#each call.images as image (image.sha256)}
    <SeenImage threadId={directory.currentId} blob={image} name={look.subject || `${look.title} image`} />
  {/each}
  <Body {call} {input} {status} {streaming} />
  <RawToggle
    parts={[
      { label: "Input", text: call.inputJson === "{}" || call.inputJson === "null" ? "" : call.inputJson },
      { label: "Result", text: call.output },
    ]}
  />
</ItemFrame>

<script lang="ts">
  import type { Item } from "@canopy/contracts";
  import { parseObject, str } from "#lib/shared/json.ts";
  import { structure, structureJson } from "#lib/shared/structure.ts";
  import { languageOfPath } from "#lib/shared/ui/code/languages.ts";
  import Diff from "../Diff.svelte";
  import StructuredView from "../items/tools/StructuredView.svelte";

  /** What a permission request asks for: a command, a file change (with its diff) or extra permissions. */
  let { toolName, requestJson, related }: { toolName: string; requestJson: string; related: Item | undefined } =
    $props();

  const request = $derived(parseObject(requestJson));
  const command = $derived(str(request["command"]));
  const cwd = $derived(str(request["cwd"]));
  const reason = $derived(str(request["reason"]));
  const changes = $derived(related?.content.case === "fileChange" ? related.content.value.changes : []);
  const relatedCommand = $derived(related?.content.case === "commandExecution" ? related.content.value.command : "");
</script>

<div class="grid gap-2">
  {#if reason}<p class="text-base/6 text-pretty text-zinc-800 sm:text-sm/6 dark:text-zinc-200">{reason}</p>{/if}
  {#if command || relatedCommand}
    <!-- Wrapped, never cut off: the person approving must see the whole command. -->
    <pre
      class="rounded-lg bg-zinc-950 p-3 font-mono text-[0.8125rem]/5 break-all whitespace-pre-wrap text-zinc-100 dark:bg-black/40"><span
        class="text-zinc-500 select-none"
        >$ </span>{command || relatedCommand}</pre>
    {#if cwd}<p class="truncate font-mono text-xs/5 text-zinc-500 dark:text-zinc-400" title={cwd}>in {cwd}</p>{/if}
  {:else if changes.length > 0}
    {#each changes as change, index (index)}
      <p class="truncate font-mono text-[0.8125rem]/5 font-medium text-zinc-950 dark:text-white">
        {change.kind === "add" ? "New file" : change.kind === "delete" ? "Delete" : "Edit"}
        {change.path}
      </p>
      {#if change.diff}<Diff
          diff={change.diff}
          label="Proposed change to {change.path}"
          lang={languageOfPath(change.path)}
          class="max-h-64"
        />{/if}
    {/each}
  {:else if toolName === "permissions" && request["permissions"]}
    <StructuredView node={structure(request["permissions"])} />
  {:else if !reason}
    <!-- Any other tool: its input as labelled fields (the raw request stays on the timeline's "Show raw"). -->
    <StructuredView node={structureJson(requestJson)} />
  {/if}
</div>

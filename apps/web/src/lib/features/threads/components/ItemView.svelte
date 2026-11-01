<script lang="ts">
  import type { Item } from "@open-agents/contracts";
  import { ItemStatus } from "@open-agents/contracts";

  /** One element of the transcript. Every item type has a view; unknown provider items show their JSON. */
  let { item }: { item: Item } = $props();

  const content = $derived(item.content);
  const inProgress = $derived(item.status === ItemStatus.IN_PROGRESS);
  const statusText = $derived(ItemStatus[item.status]?.toLowerCase().replace("_", " ") ?? "");
  const pretty = (json: string) => {
    try {
      return JSON.stringify(JSON.parse(json), null, 2);
    } catch {
      return json;
    }
  };
</script>

{#if content.case === "userMessage"}
  <div class="ml-auto max-w-[80%] rounded-2xl bg-indigo-600 px-4 py-2 text-white whitespace-pre-wrap">{content.value.text}</div>
{:else if content.case === "agentMessage"}
  {#if content.value.phase === "commentary"}
    <p class="text-sm text-slate-500 italic whitespace-pre-wrap">{content.value.text}</p>
  {:else}
    <div class="max-w-[85%] rounded-2xl bg-white px-4 py-2 shadow-sm ring-1 ring-slate-200 whitespace-pre-wrap" aria-busy={inProgress}>
      {content.value.text}{#if inProgress}<span class="animate-pulse">▍</span>{/if}
    </div>
  {/if}
{:else if content.case === "reasoning"}
  <details class="text-sm text-slate-500">
    <summary class="cursor-pointer">Reasoning{content.value.summary ? `: ${content.value.summary.split("\n")[0]}` : ""}</summary>
    <p class="mt-1 whitespace-pre-wrap">{content.value.text || content.value.summary}</p>
  </details>
{:else if content.case === "commandExecution"}
  <details class="rounded-lg bg-slate-900 text-slate-100" open={inProgress}>
    <summary class="cursor-pointer px-3 py-2 font-mono text-sm">
      <span class="text-slate-400">$</span> {content.value.command}
      <span class="ml-2 text-xs text-slate-400">
        {inProgress ? "running…" : content.value.exitCode !== undefined ? `exit ${content.value.exitCode}` : statusText}
      </span>
    </summary>
    {#if content.value.output}
      <pre class="max-h-80 overflow-auto border-t border-slate-700 px-3 py-2 text-xs">{content.value.output}</pre>
    {/if}
  </details>
{:else if content.case === "fileChange"}
  <details class="rounded-lg ring-1 ring-slate-200">
    <summary class="cursor-pointer px-3 py-2 text-sm">
      Changed {content.value.changes.length} file(s): {content.value.changes.map((c) => c.path).join(", ")}
      <span class="text-xs text-slate-500">({statusText})</span>
    </summary>
    {#each content.value.changes as change (change.path)}
      <pre class="max-h-80 overflow-auto border-t border-slate-200 px-3 py-2 text-xs"><strong>{change.kind} {change.path}</strong>
{change.diff}</pre>
    {/each}
  </details>
{:else if content.case === "toolCall"}
  <details class="rounded-lg ring-1 ring-slate-200 text-sm">
    <summary class="cursor-pointer px-3 py-2">
      Tool <code>{content.value.server ? `${content.value.server}.` : ""}{content.value.name}</code>
      <span class="text-xs {content.value.isError ? 'text-rose-600' : 'text-slate-500'}">({statusText})</span>
    </summary>
    <pre class="overflow-auto border-t border-slate-200 px-3 py-2 text-xs">{pretty(content.value.inputJson)}</pre>
    {#if content.value.output}<pre class="max-h-80 overflow-auto border-t border-slate-200 px-3 py-2 text-xs">{content.value.output}</pre>{/if}
  </details>
{:else if content.case === "agentBusCall"}
  <div class="rounded-lg bg-violet-50 px-3 py-2 text-sm ring-1 ring-violet-200">
    Agent bus: <code>{content.value.toolName}</code>
    {#if content.value.targetThreadId}→ <a class="underline" href="/threads/{content.value.targetThreadId}">side thread</a>{/if}
  </div>
{:else if content.case === "plan"}
  <div class="rounded-lg bg-slate-50 px-3 py-2 text-sm ring-1 ring-slate-200">
    <p class="font-medium">Plan</p>
    {#if content.value.text}<p class="whitespace-pre-wrap">{content.value.text}</p>{/if}
    <ul class="mt-1 space-y-0.5">
      {#each content.value.steps as step, index (index)}
        <li><span class="text-xs text-slate-500">[{step.status}]</span> {step.text}</li>
      {/each}
    </ul>
  </div>
{:else if content.case === "webSearch"}
  <p class="text-sm text-slate-500">Web search: {content.value.query}</p>
{:else if content.case === "contextCompaction"}
  <p class="text-center text-xs text-slate-400">— context compacted —</p>
{:else if content.case === "providerItem"}
  <details class="text-xs text-slate-500">
    <summary class="cursor-pointer">Provider item: {content.value.type}</summary>
    <pre class="overflow-auto">{pretty(content.value.json)}</pre>
  </details>
{:else if content.case}
  <p class="text-xs text-slate-500">{content.case} ({statusText})</p>
{/if}

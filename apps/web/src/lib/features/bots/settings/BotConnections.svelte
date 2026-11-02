<script lang="ts">
  import { bots } from "@open-agents/contracts";
  import type { ClassValue } from "svelte/elements";
  import { requestJson } from "#lib/shared/http.ts";
  import { decode } from "#lib/shared/wire.ts";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import McpServerForm from "./McpServerForm.svelte";
  let { servers = $bindable([]), selected = $bindable([]), disabled = false, class: className }: { servers?: bots.BotMcpServer[]; selected?: string[]; disabled?: boolean; class?: ClassValue } = $props();
  let adding = $state(false);
  let testing = $state<string[]>([]);
  let results = $state<Record<string, { tools?: bots.BotMcpTool[]; error?: string }>>({});
  async function test(id: string) {
    if (testing.includes(id)) return;
    testing = [...testing, id];
    try {
      const response = decode(bots.TestBotMcpServerResponseSchema, await requestJson("POST", `/api/bot-mcp-servers/${id}/test`, {}, 30000));
      results = { ...results, [id]: { tools: response.tools } };
    } catch (cause) { results = { ...results, [id]: { error: cause instanceof Error ? cause.message : "Connection failed." } }; }
    finally { testing = testing.filter((s) => s !== id); }
  }
</script>

<div class={["grid gap-4", className]}>
  {#if !servers.length}<p class="text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">No remote servers in your registry yet.</p>{/if}
  <ul role="list" class="grid gap-4">
    {#each servers as server (server.id)}
      <li class="grid min-w-0 gap-2">
        <div class="flex flex-wrap items-start justify-between gap-2">
          <div class="grid min-w-0 flex-1 gap-1 text-base/6 sm:text-sm/6">
            <p class="font-medium wrap-anywhere">{server.name}{!server.enabled ? ' · Disabled' : ''}</p>
            <p class="text-zinc-500 wrap-anywhere dark:text-zinc-400">{server.url}</p>
            {#if server.headerNames.length}<p class="text-zinc-500 dark:text-zinc-400">Secret headers: {server.headerNames.join(', ')}</p>{/if}
          </div>
          <Button size="sm" disabled={disabled || !server.enabled && !selected.includes(server.id)} aria-pressed={selected.includes(server.id)} onclick={() => (selected = selected.includes(server.id) ? selected.filter((id) => id !== server.id) : [...selected, server.id])}>{selected.includes(server.id) ? 'Detach' : 'Attach'}</Button>
        </div>
        <div><Button size="sm" disabled={disabled || testing.includes(server.id)} loading={testing.includes(server.id)} onclick={() => test(server.id)}>Test connection</Button></div>
        {#if results[server.id]?.error}<Alert tone="error">{results[server.id]?.error}</Alert>{/if}
        {#if results[server.id]?.tools}
          <div role="status" class="grid gap-2 rounded-lg bg-zinc-950/3 p-3 text-base/6 sm:text-sm/6 dark:bg-white/4">
            <p>Connected · {results[server.id]!.tools!.length} tools</p>
            <ul role="list" class="grid gap-2">
              {#each results[server.id]!.tools! as tool (tool.name)}
                <li class="min-w-0 wrap-anywhere"><p class="font-medium">{tool.name}{tool.readOnly ? ' · Read only' : ''}</p>{#if tool.description}<p class="text-zinc-500 dark:text-zinc-400">{tool.description}</p>{/if}</li>
              {/each}
            </ul>
          </div>
        {/if}
      </li>
    {/each}
  </ul>
  {#if adding}
    <McpServerForm {disabled} oncancel={() => (adding = false)} onadd={(server) => { servers = [...servers, server]; selected = [...selected, server.id]; adding = false; }} />
  {:else}<div><Button size="sm" icon="plus" {disabled} onclick={() => (adding = true)}>Add remote server</Button></div>{/if}
</div>

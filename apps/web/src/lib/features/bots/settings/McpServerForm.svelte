<script lang="ts">
  import { create } from "@bufbuild/protobuf";
  import { bots } from "@open-agents/contracts";
  import type { ClassValue } from "svelte/elements";
  import { requestJson } from "#lib/shared/http.ts";
  import { decode, encode } from "#lib/shared/wire.ts";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Field from "#lib/shared/ui/Field.svelte";
  import Input from "#lib/shared/ui/Input.svelte";
  import Select from "#lib/shared/ui/Select.svelte";
  let { onadd, oncancel, disabled = false, class: className }: { onadd: (server: bots.BotMcpServer) => void; oncancel: () => void; disabled?: boolean; class?: ClassValue } = $props();
  let name = $state("");
  let url = $state("");
  let transport = $state("http");
  let headers = $state<{ id: number; name: string; value: string }[]>([]);
  let sequence = 0;
  let busy = $state(false);
  let error = $state("");
  async function add() {
    if (busy || disabled) return;
    error = "";
    if (!name.trim() || !url.trim()) { error = "Enter a server name and URL."; return; }
    if (headers.some((h) => !h.name.trim() || !h.value) || new Set(headers.map((h) => h.name.trim().toLowerCase())).size !== headers.length) {
      error = "Each header needs a unique name and a value."; return;
    }
    busy = true;
    try {
      const body = create(bots.SaveBotMcpServerRequestSchema, { name: name.trim(), url: url.trim(), transport, enabled: true, headers: Object.fromEntries(headers.map((h) => [h.name.trim(), h.value])) });
      const response = decode(bots.SaveBotMcpServerResponseSchema, await requestJson("POST", "/api/bot-mcp-servers", encode(bots.SaveBotMcpServerRequestSchema, body)));
      headers = [];
      if (response.server) onadd(response.server);
    } catch (cause) { error = cause instanceof Error ? cause.message : "Could not add this server."; }
    finally { busy = false; }
  }
</script>

<div class={["grid gap-4 rounded-xl bg-zinc-950/3 p-4 dark:bg-white/4", className]} aria-busy={busy || undefined}>
  <Field label="Server name"><Input bind:value={name} disabled={disabled || busy} autocomplete="off" placeholder="e.g. Team knowledge" /></Field>
  <Field label="Remote URL" description="Use HTTP or HTTPS. Put authentication in headers, never in the URL."><Input type="url" bind:value={url} disabled={disabled || busy} placeholder="https://example.com/mcp" /></Field>
  <Field label="Transport"><Select bind:value={transport} disabled={disabled || busy} options={[{ value: 'http', label: 'Streamable HTTP' }, { value: 'sse', label: 'SSE' }]} /></Field>
  <div class="grid gap-3">
    <p class="text-base font-medium sm:text-sm">Secret headers</p>
    {#each headers as header (header.id)}
      <div class="grid min-w-0 gap-2">
        <Field label="Header name"><Input bind:value={header.name} disabled={disabled || busy} placeholder="Authorization" autocomplete="off" /></Field>
        <Field label="Header value"><Input type="password" bind:value={header.value} disabled={disabled || busy} placeholder="Bearer …" autocomplete="new-password" /></Field>
        <div><Button size="sm" variant="ghost" disabled={disabled || busy} onclick={() => (headers = headers.filter((h) => h.id !== header.id))}>Remove header</Button></div>
      </div>
    {/each}
    <div><Button size="sm" disabled={disabled || busy || headers.length >= 16} onclick={() => (headers = [...headers, { id: sequence++, name: '', value: '' }])}>Add header</Button></div>
    <p class="text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">Values are encrypted as secrets. Canopy only returns header names.</p>
  </div>
  {#if error}<Alert tone="error">{error}</Alert>{/if}
  <p class="text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">Adding saves the server in your registry. Save bot settings to attach it.</p>
  <div class="flex flex-wrap justify-end gap-2">
    <Button size="sm" disabled={disabled || busy} onclick={oncancel}>Cancel adding</Button>
    <Button size="sm" disabled={disabled || busy} loading={busy} onclick={add}>Add to registry</Button>
  </div>
</div>

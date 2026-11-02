<script lang="ts">
  import Crumb from "#lib/features/navigation/Crumb.svelte";
  import TopBar from "#lib/features/navigation/TopBar.svelte";
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import { create } from "@bufbuild/protobuf";
  import { bots, ProviderProfileKind, ui } from "@open-agents/contracts";
  import { requestJson } from "#lib/shared/http.ts";
  import { decode, encode } from "#lib/shared/wire.ts";
  import type { BotWizardResult } from "#lib/features/bots/live.ts";
  let instances = $state.raw<ui.ProviderInstance[]>([]);
  let selection = $state("");
  let name = $state("");
  let shape = $state("round");
  let color = $state("#38bdf8");
  let model = $state("");
  let effort = $state("");
  let error = $state("");
  let saving = $state(false);
  const requestId = crypto.randomUUID();
  onMount(() => {
    void requestJson("GET", "/api/providers").then((payload) => {
      instances = decode(ui.ListProviderInstancesResponseSchema, payload).instances.filter((i) => i.kind === ProviderProfileKind.CLIPROXYAPI);
      selection = instances[0] ? `${instances[0].harness}/${instances[0].id}` : "";
    }).catch(() => { error = "Could not load provider instances"; });
  });
  // Replace the form with feat/bots-wizard and pass this callback as oncreate.
  async function oncreate(result: BotWizardResult) {
    saving = true;
    try {
      const response = decode(bots.GetBotResponseSchema, await requestJson("POST", "/api/bots", encode(bots.CreateBotRequestSchema, create(bots.CreateBotRequestSchema, {
        clientRequestId: requestId, configuration: { ...result, provider: result.providerInstance.harness, providerInstance: result.providerInstance.id, approvalPolicy: "safe" },
      }))));
      window.dispatchEvent(new Event("bots-changed"));
      await goto(`/bots/${response.bot!.id}`);
    } catch (cause) { error = cause instanceof Error ? cause.message : "Could not create bot"; }
    finally { saving = false; }
  }
  function submit() {
    const instance = instances.find((i) => `${i.harness}/${i.id}` === selection);
    if (instance) void oncreate({ name, shape, color, providerInstance: instance, model, effort });
  }
  const field = "w-full rounded-lg border border-zinc-300 bg-transparent px-3 py-2 dark:border-zinc-700";
</script>

<svelte:head><title>Bots · Open Agents</title></svelte:head>

<div class="flex h-full flex-col">
  <TopBar><Crumb>Bots</Crumb></TopBar>
  <div class="min-h-0 flex-1 overflow-y-auto p-6">
    <form class="mx-auto grid max-w-md gap-4" onsubmit={(event) => { event.preventDefault(); submit(); }}>
      <h1 class="text-xl font-semibold">Create a bot</h1>
      <label class="grid gap-1 text-sm">Name<input class={field} bind:value={name} maxlength="80" required /></label>
      <label class="grid gap-1 text-sm">Shape<select class={field} bind:value={shape}>{#each ["round", "squircle", "ghost", "cloud", "drop", "capsule", "triangle"] as value}<option value={value}>{value}</option>{/each}</select></label>
      <label class="grid gap-1 text-sm">Colour<input type="color" bind:value={color} /></label>
      <label class="grid gap-1 text-sm">Provider instance<select class={field} bind:value={selection} required>{#each instances as i}<option value={`${i.harness}/${i.id}`}>{i.label || i.id}</option>{/each}</select></label>
      {#if !instances.length}<p class="text-sm text-zinc-500">Add an endpoint provider in <a href="/settings/providers" class="underline">Settings → Providers</a> to create a bot.</p>{/if}
      <label class="grid gap-1 text-sm">Model<input class={field} bind:value={model} required maxlength="200" placeholder="Model ID" /></label>
      <label class="grid gap-1 text-sm">Effort<select class={field} bind:value={effort}><option value="">Default</option>{#each ["low", "medium", "high"] as value}<option value={value}>{value}</option>{/each}</select></label>
      {#if error}<p role="alert" class="text-sm text-red-500">{error}</p>{/if}
      <button class="rounded-lg bg-brand-600 px-4 py-2 text-white disabled:opacity-50" disabled={saving || !selection}>{saving ? "Creating…" : "Create bot"}</button>
    </form>
  </div>
</div>

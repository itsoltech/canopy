<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import SensitiveUrl from "#lib/shared/ui/SensitiveUrl.svelte";

  let { kind, baseUrl, class: className }: { kind: string; baseUrl: string; class?: ClassValue } = $props();
  const root = $derived(baseUrl.trim().replace(/\/+$/, "").replace(/\/v1$/, "") || "<proxy>");
</script>

<dl
  class={[
    "grid min-w-0 gap-3 text-base/6 text-zinc-500 sm:grid-cols-[auto_1fr] sm:gap-x-5 sm:text-sm/6 dark:text-zinc-400",
    className,
  ]}
>
  <dt class="font-medium text-zinc-950 dark:text-white">Claude</dt>
  <dd class="min-w-0 break-words">
    {#if kind === "openai"}Not applicable: Claude requires the Anthropic Messages API.
    {:else}ANTHROPIC_BASE_URL=<SensitiveUrl value={root} />; secret in ANTHROPIC_AUTH_TOKEN; ANTHROPIC_API_KEY empty.{/if}
  </dd>
  <dt class="font-medium text-zinc-950 dark:text-white">Codex</dt>
  <dd class="min-w-0 break-words">
    {#if kind === "anthropic"}Not applicable: Codex requires the OpenAI Responses API.
    {:else}<SensitiveUrl value={`${root}/v1`} /> · Responses · isolated CODEX_HOME · key through env_key.{/if}
  </dd>
  <dt class="font-medium text-zinc-950 dark:text-white">Grok</dt>
  <dd class="min-w-0 break-words">
    {#if kind === "anthropic"}Not applicable: this preset maps Grok to OpenAI Chat Completions.
    {:else}<SensitiveUrl value={`${root}/v1`} /> · custom model · Chat Completions · isolated GROK_HOME.{/if}
  </dd>
</dl>

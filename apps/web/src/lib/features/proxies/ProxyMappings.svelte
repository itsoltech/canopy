<script lang="ts">
  import type { ClassValue } from "svelte/elements";

  let { kind, baseUrl, class: className }: { kind: string; baseUrl: string; class?: ClassValue } = $props();
  const root = $derived(baseUrl.trim().replace(/\/+$/, "").replace(/\/v1$/, "") || "<proxy>");
</script>

<div class={["grid gap-2 text-base/6 sm:text-sm/6", className]}>
  <h3 class="font-medium text-zinc-950 dark:text-white">Harness mapping</h3>
  <dl class="grid min-w-0 gap-3 text-zinc-500 sm:grid-cols-[auto_1fr] sm:gap-x-5 dark:text-zinc-400">
    <dt class="font-medium text-zinc-950 dark:text-white">Claude</dt>
    <dd class="min-w-0 break-words">
      {kind === "openai"
        ? "Not applicable: Claude requires the Anthropic Messages API."
        : `ANTHROPIC_BASE_URL=${root}; secret in ANTHROPIC_AUTH_TOKEN; ANTHROPIC_API_KEY empty.`}
    </dd>
    <dt class="font-medium text-zinc-950 dark:text-white">Codex</dt>
    <dd class="min-w-0 break-words">
      {kind === "anthropic"
        ? "Not applicable: Codex requires the OpenAI Responses API."
        : `${root}/v1 · Responses · isolated CODEX_HOME · key through env_key.`}
    </dd>
    <dt class="font-medium text-zinc-950 dark:text-white">Grok</dt>
    <dd class="min-w-0 break-words">
      {kind === "anthropic"
        ? "Not applicable: this preset maps Grok to OpenAI Chat Completions."
        : `${root}/v1 · custom model · Chat Completions · isolated GROK_HOME.`}
    </dd>
  </dl>
</div>

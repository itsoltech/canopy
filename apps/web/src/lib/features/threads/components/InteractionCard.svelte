<script lang="ts">
  import { InteractionKind, type ui } from "@open-agents/contracts";
  import { answerInteraction } from "../api.ts";

  /** A provider waiting for a human: permission (allow/deny) or a question (free answer). */
  let { interaction }: { interaction: ui.Interaction } = $props();

  let busy = $state(false);
  let error = $state<string | undefined>(undefined);
  let answer = $state("");

  const request = $derived.by(() => {
    try {
      return JSON.parse(interaction.requestJson) as Record<string, unknown>;
    } catch {
      return {};
    }
  });
  const summary = $derived(
    typeof request["command"] === "string" ? request["command"] : typeof request["reason"] === "string" ? request["reason"] : interaction.toolName,
  );

  async function respond(body: Parameters<typeof answerInteraction>[1]) {
    busy = true;
    error = undefined;
    try {
      await answerInteraction(interaction.requestId, body);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }
</script>

<section class="rounded-xl border border-amber-300 bg-amber-50 p-4" aria-labelledby="interaction-{interaction.requestId}">
  <h3 id="interaction-{interaction.requestId}" class="font-medium text-amber-950">
    {interaction.kind === InteractionKind.PERMISSION ? "Permission requested" : "Question"}: {interaction.toolName}
  </h3>
  <pre class="mt-2 max-h-48 overflow-auto rounded bg-white p-2 text-xs ring-1 ring-amber-200">{summary}</pre>
  {#if interaction.kind === InteractionKind.PERMISSION}
    <div class="mt-3 flex flex-wrap gap-2">
      <button class="btn-primary" disabled={busy} onclick={() => respond({ allow: true })}>Allow</button>
      <button class="btn" disabled={busy} onclick={() => respond({ allow: true, allowForSession: true })}>Allow for this session</button>
      <button class="btn-danger" disabled={busy} onclick={() => respond({ allow: false, message: "Denied by the user" })}>Deny</button>
    </div>
  {:else}
    <form class="mt-3 flex gap-2" onsubmit={(e) => (e.preventDefault(), respond({ answerJson: JSON.stringify({ answer }) }))}>
      <label class="sr-only" for="answer-{interaction.requestId}">Answer</label>
      <input id="answer-{interaction.requestId}" class="input flex-1" bind:value={answer} required />
      <button class="btn-primary" disabled={busy}>Answer</button>
      <button class="btn" type="button" disabled={busy} onclick={() => respond({ cancelled: true })}>Dismiss</button>
    </form>
  {/if}
  {#if error}<p class="mt-2 text-sm text-rose-700" role="alert">{error}</p>{/if}
</section>

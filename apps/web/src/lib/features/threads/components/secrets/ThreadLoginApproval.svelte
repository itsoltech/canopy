<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import Button from "#lib/shared/ui/Button.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import { answerThreadSecret } from "../../api.ts";

  /** A project login set to ask each time: the agent waits until the owner allows it for this turn or declines. */
  let {
    secret,
    onchange,
    class: className,
  }: { secret: ui.ThreadSecret; onchange: (secret: ui.ThreadSecret) => void; class?: ClassValue } = $props();

  let busy = $state(false);
  let failure = $state("");
  const site = $derived(secret.origin.replace(/^https:\/\//, ""));
  const file = $derived(secret.access === "file");

  async function answer(decline: boolean) {
    if (busy) return;
    busy = true;
    failure = "";

    try {
      const updated = await answerThreadSecret(secret.requestId, decline ? { decline: true } : {});

      if (updated) onchange(updated);
    } catch {
      failure = "Could not send your answer. Try again.";
    } finally {
      busy = false;
    }
  }
</script>

<section
  aria-label="Login request"
  class={[
    "grid min-w-0 gap-3 rounded-xl border border-zinc-950/10 bg-white p-4 dark:border-white/10 dark:bg-zinc-900",
    className,
  ]}
>
  <div class="flex min-w-0 items-start gap-2 text-base/6 sm:text-sm/6">
    <div class="flex h-lh shrink-0 items-center">
      <Icon name="lock-closed" class="fill-zinc-500 dark:fill-zinc-400" />
    </div>
    <div class="grid min-w-0 flex-1 gap-1">
      <h2 class="font-medium text-balance wrap-anywhere text-zinc-950 dark:text-white">
        {file ? "Give login" : "Use login"} <span class="font-mono">{secret.projectSecret}</span>{file
          ? " to the agent’s commands"
          : ""}?
      </h2>
      <p class="text-pretty wrap-anywhere text-zinc-600 dark:text-zinc-400">
        {#if file}
          The agent wants it as a private file for scripts or API tests. Its commands can read the password.
        {:else}
          The agent wants to sign in on {site || "a website"}. Canopy enters the password. The agent never sees it.
        {/if}
      </p>
    </div>
  </div>
  <div class="flex flex-wrap items-center gap-2">
    <Button variant="primary" loading={busy} onclick={() => void answer(false)}>Allow for this turn</Button>
    <Button variant="ghost" disabled={busy} onclick={() => void answer(true)}>Decline</Button>
  </div>
  {#if failure}<p role="alert" class="text-base/6 text-rose-600 sm:text-sm/5 dark:text-rose-400">{failure}</p>{/if}
</section>

<script lang="ts">
  import { onDestroy } from "svelte";
  import type { ui } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import { timestampMs } from "@bufbuild/protobuf/wkt";
  import { clock } from "#lib/shared/clock.svelte.ts";
  import { formatDateTime, isoDateTime } from "#lib/shared/format.ts";
  import Button from "#lib/shared/ui/Button.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import Input from "#lib/shared/ui/Input.svelte";
  import { swap } from "#lib/shared/ui/motion.ts";
  import { answerThreadSecret } from "../../api.ts";
  import { registerUnsentWork } from "#lib/features/workers/unsent-work.ts";

  let {
    secret,
    onchange,
    class: className,
  }: { secret: ui.ThreadSecret; onchange: (secret: ui.ThreadSecret) => void; class?: ClassValue } = $props();

  const id = $props.id();
  let value = $state("");
  let revealed = $state(false);
  let busy = $state(false);
  let failure = $state("");

  $effect(() => registerUnsentWork(() => !!value.length || busy));

  const expired = $derived(
    secret.status === "saved" && !!secret.expiresAt && timestampMs(secret.expiresAt) <= clock.now,
  );

  const status = $derived(expired ? "expired" : secret.status);

  $effect(() => {
    if (secret.status !== "pending") {
      value = "";
      revealed = false;
    }
  });

  onDestroy(() => {
    value = "";
  });

  async function send(action: "save" | "decline" | "revoke") {
    if (busy || (action === "save" && !value.length)) return;
    busy = true;
    failure = "";
    const answer = action === "save" ? { value } : action === "decline" ? { decline: true } : { revoke: true };
    value = "";
    revealed = false;

    try {
      const updated = await answerThreadSecret(secret.requestId, answer);

      if (updated) onchange(updated);
    } catch {
      failure =
        action === "save"
          ? "Could not save the secret. Paste it again to retry."
          : "Could not update the secret. Try again.";
    } finally {
      busy = false;
    }
  }

  async function paste() {
    try {
      value = await navigator.clipboard.readText();
      failure = "";
    } catch {
      failure = "Use your browser’s Paste command in the secret field.";
    }
  }
</script>

<section
  aria-label="Secret request"
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
      <h2 class="font-medium text-balance wrap-anywhere text-zinc-950 dark:text-white">{secret.label}</h2>
      {#if status === "pending"}<p class="text-pretty wrap-anywhere text-zinc-600 dark:text-zinc-400">
          {secret.description}
        </p>{/if}
    </div>
  </div>
  {#if status === "pending"}
    <form
      class="grid min-w-0 gap-3"
      autocomplete="off"
      onsubmit={(e) => {
        e.preventDefault();
        void send("save");
      }}
    >
      <div class="flex min-w-0 items-center gap-2">
        <div class="min-w-0 flex-1">
          <Input
            {id}
            name="thread-secret"
            type="text"
            bind:value
            class={!revealed ? "[-webkit-text-security:disc]" : undefined}
            aria-label={secret.label}
            aria-describedby="{id}-privacy"
            aria-invalid={!!failure || undefined}
            placeholder={secret.placeholder || "Paste the secret"}
            autocomplete="off"
            autocorrect="off"
            autocapitalize="off"
            spellcheck={false}
            data-1p-ignore
            data-lpignore="true"
            data-bwignore
            disabled={busy}
          />
        </div>
        <IconButton
          icon={revealed ? "eye-slash" : "eye"}
          label={revealed ? "Hide secret" : "Reveal secret"}
          aria-pressed={revealed}
          disabled={busy}
          onclick={() => (revealed = !revealed)}
        />
        <IconButton icon="clipboard-document" label="Paste secret" disabled={busy} onclick={() => void paste()} />
      </div>
      <p id="{id}-privacy" class="text-base/6 text-pretty text-zinc-500 sm:text-sm/5 dark:text-zinc-400">
        Kept out of chat, in a private file this agent’s commands can read for 24 hours. You can revoke access at any
        time.
      </p>
      <div class="flex flex-wrap items-center gap-2">
        <Button type="submit" variant="primary" disabled={busy || !value.length} loading={busy}>Save securely</Button>
        <Button type="button" variant="ghost" disabled={busy} onclick={() => void send("decline")}>Decline</Button>
      </div>
    </form>
  {:else}
    <div class="flex min-w-0 flex-wrap items-center justify-between gap-2 text-base/6 sm:text-sm/6" aria-live="polite">
      {#key status}
        <p in:swap class="min-w-0 text-pretty text-zinc-600 dark:text-zinc-400">
          {#if status === "saved" && secret.expiresAt}Secret saved · available until <time
              class="tabular-nums"
              datetime={isoDateTime(secret.expiresAt)}>{formatDateTime(secret.expiresAt)}</time
            >
          {:else if status === "declined"}Secret request declined
          {:else if status === "revoked"}Secret access revoked
          {:else}Secret expired{/if}
        </p>
      {/key}
      {#if status === "saved"}<Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={busy}
          onclick={() => void send("revoke")}>Revoke</Button
        >{/if}
    </div>
  {/if}
  {#if failure}<p role="alert" class="text-base/6 text-rose-600 sm:text-sm/5 dark:text-rose-400">{failure}</p>{/if}
</section>

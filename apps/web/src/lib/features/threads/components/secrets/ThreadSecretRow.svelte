<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import { formatDateTime, formatTime } from "#lib/shared/format.ts";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import { toast } from "#lib/shared/ui/toast.svelte.ts";
  import { tooltip } from "#lib/shared/ui/tooltip.ts";
  import TruncatedText from "#lib/shared/ui/TruncatedText.svelte";
  import { answerThreadSecret } from "../../api.ts";
  import PanelRow from "../PanelRow.svelte";

  /**
   * A saved secret in the thread panel: its label (a project secret's name), until when the agent can read it, and
   * Revoke. Revoking a project secret ends only this thread's access; Project settings → Secrets deletes it.
   */
  let { secret, onchange }: { secret: ui.ThreadSecret; onchange: (secret: ui.ThreadSecret) => void } = $props();
  let busy = $state(false);
  const name = $derived(secret.projectSecret || secret.label || "Secret");

  const until = (time: string) =>
    secret.projectSecret
      ? `The agent's commands can read this project secret until ${time}. Kept out of chat.`
      : `The agent's commands can read this until ${time}. Kept out of chat.`;

  async function revoke() {
    busy = true;

    try {
      const updated = await answerThreadSecret(secret.requestId, { revoke: true });

      if (updated) onchange(updated);
    } catch {
      toast("Could not revoke the secret. Try again.", { tone: "error" });
    } finally {
      busy = false;
    }
  }
</script>

<PanelRow icon="lock-closed">
  <TruncatedText text={name} class={secret.projectSecret ? "font-mono" : undefined} />
  {#snippet aside()}
    <span class="flex shrink-0 items-center gap-1">
      {#if secret.expiresAt}<span
          class="text-sm/5 text-zinc-500 tabular-nums sm:text-xs/5 dark:text-zinc-400"
          {@attach tooltip(until(formatDateTime(secret.expiresAt)))}>until {formatTime(secret.expiresAt)}</span
        >{/if}
      <IconButton
        icon="x-mark"
        size="sm"
        label={secret.projectSecret ? `Revoke ${name} in this thread` : `Revoke ${name}`}
        loading={busy}
        onclick={() => void revoke()}
      />
    </span>
  {/snippet}
</PanelRow>

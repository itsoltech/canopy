<script lang="ts">
  import type { ui } from "@open-agents/contracts";
  import { formatDateTime, formatTime } from "#lib/shared/format.ts";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import { toast } from "#lib/shared/ui/toast.svelte.ts";
  import { tooltip } from "#lib/shared/ui/tooltip.ts";
  import { answerThreadSecret } from "../../api.ts";
  import PanelRow from "../PanelRow.svelte";

  /** A saved secret in the thread panel: its label, until when the agent can read it, and Revoke. */
  let { secret, onchange }: { secret: ui.ThreadSecret; onchange: (secret: ui.ThreadSecret) => void } = $props();
  let busy = $state(false);

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
  <span {@attach tooltip(secret.expiresAt ? `Kept out of chat; the agent's commands can read it until ${formatDateTime(secret.expiresAt)}` : undefined)}>{secret.label || "Secret"}</span>
  {#snippet aside()}
    <span class="flex shrink-0 items-center gap-1">
      {#if secret.expiresAt}<span class="text-sm/5 text-zinc-500 tabular-nums sm:text-xs/5 dark:text-zinc-400">until {formatTime(secret.expiresAt)}</span>{/if}
      <IconButton icon="x-mark" size="sm" label="Revoke {secret.label || 'secret'}" loading={busy} onclick={() => void revoke()} />
    </span>
  {/snippet}
</PanelRow>

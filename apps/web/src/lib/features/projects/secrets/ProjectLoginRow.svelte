<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import Badge from "#lib/shared/ui/Badge.svelte";
  import Button from "#lib/shared/ui/Button.svelte";

  /** One login in project settings: name, who it signs in as and where, how agents may use it. */
  let { secret, onedit, ondelete }: { secret: ui.ProjectSecret; onedit: () => void; ondelete: () => void } = $props();

  const login = $derived(secret.login);

  const details = $derived(
    [
      login?.username && `${login.username}${login.showUsername ? "" : " (hidden from agents)"}`,
      (login?.websites ?? []).map((website) => website.replace(/^https:\/\//, "")).join(", "),
      login?.oneTimeCode && "One-time code",
      login?.outsideBrowser && "Also outside the browser",
    ]
      .filter(Boolean)
      .join(" · "),
  );
</script>

<div class="settings-row flex flex-col items-start gap-3 px-4 py-3.5 sm:flex-row sm:items-center">
  <div class="settings-row-copy min-w-0 flex-1">
    <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
      <p class="font-mono text-base/6 font-medium wrap-anywhere text-zinc-950 sm:text-sm/6 dark:text-white">
        {secret.name}
      </p>
      <Badge compact tone={login?.askEachTime ? "amber" : "neutral"}
        >{login?.askEachTime ? "Ask each time" : "Automatic"}</Badge
      >
    </div>
    <p class="text-sm/5 wrap-anywhere text-zinc-500 dark:text-zinc-400">{details}</p>
  </div>
  <div class="settings-row-control flex shrink-0 items-center gap-2">
    <Button size="sm" aria-label={`Edit ${secret.name}`} onclick={onedit}>Edit</Button>
    <Button size="sm" variant="ghost" aria-label={`Delete ${secret.name}`} onclick={ondelete}>Delete</Button>
  </div>
</div>

<script lang="ts">
  import Button from "#lib/shared/ui/Button.svelte";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";
  import { toast } from "#lib/shared/ui/toast.svelte.ts";

  let { manifest }: { manifest: string } = $props();

  async function copyManifest() {
    try {
      await navigator.clipboard.writeText(manifest);
      toast("Slack manifest copied");
    } catch {
      toast("Could not copy the manifest. Allow clipboard access and try again.", { tone: "error" });
    }
  }
</script>

<Disclosure summaryClass="py-1">
  {#snippet summary()}Update the Slack app{/snippet}
  <div class="grid gap-3 pt-3 text-sm text-zinc-500 dark:text-zinc-400">
    <ol class="grid list-decimal gap-2 pl-5">
      <li>
        Open the registered app’s App Manifest in Slack. Add the manifest’s message scopes, events and Socket Mode
        settings.
      </li>
      <li>
        Set <code>oauth_config.pkce_enabled</code> to <code>true</code>. Add the manifest’s bot user and App Home
        settings.
      </li>
      <li>
        Keep token rotation enabled if the app already uses it. Canopy refreshes rotating bot tokens automatically.
      </li>
      <li>Save the manifest and reinstall the same app in your workspace.</li>
      <li>
        Generate an app-level token with connections:write in Basic Information. Save it here, then authorize messages.
      </li>
      <li>Invite the app to channels your bots should read.</li>
    </ol>
    <div class="flex flex-wrap items-center gap-3">
      <a
        href="https://api.slack.com/apps"
        target="_blank"
        rel="noopener noreferrer"
        class="font-medium text-zinc-950 underline underline-offset-4 dark:text-white">Open Slack apps</a
      >
      <Button size="sm" disabled={!manifest} onclick={copyManifest}>Copy manifest</Button>
    </div>
  </div>
</Disclosure>

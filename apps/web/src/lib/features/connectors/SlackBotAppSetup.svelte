<script lang="ts">
  import Button from "#lib/shared/ui/Button.svelte";
  import ButtonLink from "#lib/shared/ui/ButtonLink.svelte";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";
  import { toast } from "#lib/shared/ui/toast.svelte.ts";

  let { manifest, createUrl, shared = false }: { manifest: string; createUrl?: string; shared?: boolean } = $props();

  async function copyManifest() {
    try {
      await navigator.clipboard.writeText(manifest);
      toast("Slack manifest copied");
    } catch {
      toast("Could not copy the manifest. Allow clipboard access and try again.", { tone: "error" });
    }
  }
</script>

<Disclosure open={!shared} summaryClass="text-base/6 sm:text-sm/6">
  {#snippet summary()}{shared ? "Update the Slack app" : "Set up the Slack app"}{/snippet}
  <div class="grid gap-3 pt-3 text-sm/5 text-zinc-500 dark:text-zinc-400">
    <ol class="grid list-decimal gap-2 pl-5">
      {#if shared}
        <li>Add the manifest’s bot scopes, events, and Socket Mode settings to your app in Slack.</li>
        <li>Enable PKCE in the app manifest and add the bot user and App Home settings.</li>
        <li>Save the manifest and reinstall the app in your workspace.</li>
      {:else if createUrl}
        <li>Create the Slack app and install it in your workspace. Keep bot token rotation off.</li>
      {:else}
        <li>Create an app in Slack. Enable Socket Mode, bot events, and the Messages tab in App Home.</li>
        <li>Add the bot scopes and install the app in your workspace. Keep bot token rotation off.</li>
      {/if}
      <li>In Basic Information, generate an app-level token with <code>connections:write</code>.</li>
      {#if shared}
        <li>Save the token in Canopy, then authorize Slack Bot.</li>
      {:else}
        <li>In OAuth &amp; Permissions, copy the Bot User OAuth Token.</li>
      {/if}
      <li>Invite the app to the channels where it should receive messages.</li>
    </ol>
    <div class="flex flex-wrap gap-2 max-sm:pr-10">
      <ButtonLink href={createUrl || "https://api.slack.com/apps"} target="_blank" rel="noopener noreferrer" size="sm">
        {createUrl ? "Create the Slack app" : "Open Slack apps"}
      </ButtonLink>
      {#if manifest}<Button size="sm" onclick={copyManifest}>Copy manifest</Button>{/if}
    </div>
  </div>
</Disclosure>

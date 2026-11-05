<script lang="ts">
  import type { connectors } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import Button from "#lib/shared/ui/Button.svelte";
  import ButtonLink from "#lib/shared/ui/ButtonLink.svelte";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";
  import SegmentedChoice from "#lib/shared/ui/SegmentedChoice.svelte";
  import { toast } from "#lib/shared/ui/toast.svelte.ts";
  import CallbackUrl from "./CallbackUrl.svelte";
  import StepList from "./StepList.svelte";

  /**
   * The Slack app to save: create it from the manifest Canopy builds, or use one a colleague already made.
   * Both paths end in the client ID and secret fields below; the redirect URL is a detail for manual setups.
   */
  let { method, class: className }: { method: connectors.ConnectorAuthMethod; class?: ClassValue } = $props();

  let path = $state("create");
  let copied = $state(false);

  const steps = [
    "Open Slack with the app filled in, then choose your workspace.",
    "Select Create, then Install to Workspace.",
    "Copy the client ID and client secret from Basic Information.",
    "Paste them below and save the app.",
  ];

  let timer: ReturnType<typeof setTimeout> | undefined;

  $effect(() => () => clearTimeout(timer));

  async function copyManifest() {
    try {
      await navigator.clipboard.writeText(method.appManifest);
      copied = true;
      clearTimeout(timer);
      timer = setTimeout(() => (copied = false), 1500);
    } catch {
      toast("Copying is not allowed here", { tone: "error" });
    }
  }
</script>

<div class={["grid gap-3", className]}>
  <SegmentedChoice
    label="Slack app"
    bind:value={path}
    options={[
      { value: "create", label: "Create the Slack app" },
      { value: "existing", label: "Use an existing Slack app" },
    ]}
    class="w-full [&>button]:flex-1"
  />
  {#if path === "create"}
    <StepList {steps} class="text-base/6 sm:text-sm/6" />
    <div class="flex flex-wrap gap-2">
      <ButtonLink
        href={method.appCreateUrl}
        target="_blank"
        rel="noreferrer noopener"
        variant="primary"
        size="sm"
        icon="arrow-top-right-on-square">Create the Slack app</ButtonLink
      >
      <Button size="sm" icon={copied ? "copied" : "copy"} onclick={copyManifest}
        >{copied ? "Manifest copied" : "Copy manifest"}</Button
      >
    </div>
    <p class="text-base/6 text-pretty text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
      Install the app only to your own workspace. Slack lets only internal apps use MCP.
    </p>
  {:else}
    <p class="text-base/6 text-pretty text-zinc-600 sm:text-sm/6 dark:text-zinc-300">
      Ask the app's owner for its client ID and client secret, then paste them below.
    </p>
  {/if}
  <Disclosure summaryClass="text-base/6 sm:text-sm/6"
    >{#snippet summary()}Redirect URL for a manual setup{/snippet}
    <CallbackUrl url={method.redirectUrl} label="Redirect URL" copyLabel="Copy redirect URL" class="pt-3" /></Disclosure
  >
</div>

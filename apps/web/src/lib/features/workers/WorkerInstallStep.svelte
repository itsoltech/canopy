<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import Field from "#lib/shared/ui/Field.svelte";
  import Input from "#lib/shared/ui/Input.svelte";
  import CommandBlock from "./CommandBlock.svelte";
  import SetupTabs from "./SetupTabs.svelte";
  let { name, command, copyable, os = $bindable("linux"), source = $bindable("clone"), repository = $bindable(""), checkout = $bindable(""), class: className }:
    { name: string; command: string; copyable: boolean; os?: string; source?: string; repository?: string; checkout?: string; class?: ClassValue } = $props();
</script>

<div class={["grid min-w-0 gap-4", className]}>
  <p class="text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">Run this on <strong class="font-medium text-zinc-700 dark:text-zinc-200">{name}</strong>. You need Git, network access to the gateway and access to the Canopy source. The command installs Bun if needed. There is no published worker binary yet.</p>
  <SetupTabs label="Operating system" bind:value={os} options={[{ value: "linux", label: "Linux" }, { value: "darwin", label: "macOS" }]} />
  <SetupTabs label="Worker source" bind:value={source} options={[{ value: "clone", label: "Clone repository" }, { value: "existing", label: "Existing checkout" }]} />
  {#if source === "clone"}<Field label="Canopy repository URL" description="Use the repository you have access to. Git may ask you to authenticate."><Input name="repository" bind:value={repository} placeholder="https://github.com/your-org/canopy.git" /></Field>
  {:else}<Field label="Canopy checkout on this machine" description="Absolute path to an existing checkout with this version of Canopy."><Input name="checkout" bind:value={checkout} placeholder="/home/you/canopy" /></Field>{/if}
  <CommandBlock text={command} {copyable} label={`${os === "darwin" ? "macOS" : "Linux"} · Terminal`} />
  <p class="text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">Keep this command private until enrollment. The token works once. Install and sign in to Claude, Codex or Grok separately on the machine.</p>
</div>

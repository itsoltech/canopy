<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import CopyButton from "#lib/shared/ui/CopyButton.svelte";
  import SettingsSection from "./SettingsSection.svelte";

  let { status }: { status: ui.InstanceOnWorker | undefined } = $props();

  const paths = $derived(
    status?.reported
      ? [
          { label: "Login source", value: status.loginHomePath },
          { label: "Configuration source", value: status.configurationHomePath },
          { label: "Thread history", value: status.sessionHomePath },
          { label: "Private state", value: status.privateHomePath },
        ].filter((path) => path.value)
      : [],
  );
</script>

{#if paths.length > 0}
  <SettingsSection title="Reported paths">
    <dl class="grid min-w-0 gap-3 text-base/6 sm:text-sm/6">
      {#each paths as path (path.label)}
        <div class="grid min-w-0 gap-x-4 gap-y-1 sm:grid-cols-[9rem_minmax(0,1fr)]">
          <dt class="text-zinc-500 dark:text-zinc-400">{path.label}</dt>
          <dd class="flex min-w-0 items-start gap-2">
            <code class="min-w-0 flex-1 font-mono break-all text-zinc-950 select-text dark:text-white">
              {path.value}
            </code>
            <CopyButton text={path.value} label="Copy {path.label.toLowerCase()}" />
          </dd>
        </div>
      {/each}
    </dl>
    <p class="text-sm/5 text-pretty text-zinc-500 dark:text-zinc-400">
      Existing threads may keep their previous history directory.
    </p>
  </SettingsSection>
{/if}

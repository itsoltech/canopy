<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import Switch from "#lib/shared/ui/Switch.svelte";

  let {
    webAccess = $bindable(true),
    files = $bindable(true),
    disabled = false,
    class: className,
  }: { webAccess?: boolean; files?: boolean; disabled?: boolean; class?: ClassValue } = $props();

  const capabilities = [
    { key: "webAccess", label: "Web access", description: "Search the web and read public pages." },
    { key: "files", label: "Files", description: "Create, download, and send files in this conversation." },
  ] as const;
</script>

<div class={["grid gap-4", className]}>
  {#each capabilities as capability (capability.key)}
    <label class="flex min-w-0 items-center justify-between gap-4">
      <div class="grid min-w-0 gap-1 text-base/6 sm:text-sm/6">
        <p class="font-medium text-zinc-800 dark:text-zinc-200">{capability.label}</p>
        <p class="text-pretty text-zinc-500 dark:text-zinc-400">{capability.description}</p>
      </div>
      <Switch
        name={capability.key}
        label={capability.label}
        checked={capability.key === "webAccess" ? webAccess : files}
        {disabled}
        onchange={(value) => {
          if (capability.key === "webAccess") webAccess = value;
          else files = value;
        }}
      />
    </label>
  {/each}
  <p class="text-base/6 text-pretty text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
    Files stay separate from your projects. Downloads require Files. Connections keep their own permissions.
  </p>
</div>

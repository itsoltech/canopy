<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import { useSettings } from "#lib/features/settings/settings-state.svelte.ts";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import HintIcon from "#lib/shared/ui/HintIcon.svelte";
  import Switch from "#lib/shared/ui/Switch.svelte";
  import { updateThread } from "../api.ts";

  let {
    thread,
    disabled = false,
    class: className,
  }: { thread: ui.Thread; disabled?: boolean; class?: ClassValue } = $props();

  const settings = useSettings();
  let pending = $state(false);
  let draft = $state<{ threadId: string; value: boolean }>();
  let failed = $state(false);
  const project = $derived(settings.projectDefaults(thread.projectId).autoArchiveOnMerge);
  const inherited = $derived(project ?? settings.threadDefaults.autoArchiveOnMerge ?? false);
  const override = $derived(draft?.threadId === thread.id ? draft.value : thread.autoArchiveOnMerge);
  const enabled = $derived(override ?? inherited);
  const inactive = $derived(disabled || pending || !settings.loaded || !!thread.archivedAt);

  const help = $derived(
    `${override !== undefined ? "Set for this thread." : project !== undefined ? "Uses the project default." : "Uses your default."} Waits for all linked pull requests to merge and active work to finish.`,
  );

  async function save(value: boolean) {
    if (inactive) return;
    pending = true;
    failed = false;
    draft = { threadId: thread.id, value };

    try {
      await updateThread(thread.id, { autoArchiveOnMerge: value });
    } catch {
      failed = true;
    } finally {
      draft = undefined;
      pending = false;
    }
  }
</script>

<div class={["grid min-w-0 px-2", className]}>
  <div class="flex min-h-9 min-w-0 items-center gap-1 sm:min-h-8">
    <span class="min-w-0 flex-1 text-base/5 text-zinc-700 sm:text-sm/5 dark:text-zinc-300">
      Auto-archive after merge
    </span>
    <HintIcon label="About auto-archive after merge" text={help} />
    <Switch
      name="threadAutoArchiveOnMerge"
      size="sm"
      label="Auto-archive after merge"
      checked={enabled}
      disabled={inactive}
      onchange={(value) => void save(value)}
    />
  </div>
  {#if failed}<Alert tone="error">Could not save auto-archive. Check the connection, then retry.</Alert>{/if}
</div>

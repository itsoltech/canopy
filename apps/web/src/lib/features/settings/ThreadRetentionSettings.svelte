<script lang="ts">
  import { useSettings } from "./settings-state.svelte.ts";
  import PreferenceRow from "./PreferenceRow.svelte";
  import SettingsGroup from "#lib/shared/ui/SettingsGroup.svelte";
  import SettingsRow from "#lib/shared/ui/SettingsRow.svelte";
  import Input from "#lib/shared/ui/Input.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Switch from "#lib/shared/ui/Switch.svelte";

  const settings = useSettings();
  const id = $props.id();
  const saved = $derived(settings.user.threadRetention?.archivedThreadDays ?? 0);
  let draft = $state<{ enabled: boolean; days: number | null }>();
  let pending = $state(false);
  const value = $derived(draft ?? { enabled: saved > 0, days: saved || 14 });

  const validDays = $derived(
    value.days !== null && Number.isInteger(value.days) && value.days >= 1 && value.days <= 36500,
  );

  const valid = $derived(!value.enabled || validDays);
  const days = $derived(value.enabled ? (value.days ?? 0) : 0);
  const disabled = $derived(!settings.loaded || pending);

  async function save() {
    if (disabled || !valid || days === saved) return;
    pending = true;

    try {
      if (await settings.updateThreadRetention(days)) draft = undefined;
    } finally {
      pending = false;
    }
  }
</script>

<SettingsGroup
  title="Archived threads"
  description="Permanently deletes threads and their history after this many days in the archive."
>
  <form
    onsubmit={(event) => {
      event.preventDefault();
      void save();
    }}
  >
    <PreferenceRow
      title="Auto-delete archived threads"
      description="Applies to existing archived threads."
      changed={value.enabled}
      onreset={() => {
        if (!disabled) draft = { enabled: false, days: 14 };
      }}
    >
      {#snippet control()}
        <Switch
          name="autoDeleteArchivedThreads"
          label="Auto-delete archived threads"
          checked={value.enabled}
          {disabled}
          onchange={(enabled) => (draft = { enabled, days: validDays ? value.days : 14 })}
        />
      {/snippet}
    </PreferenceRow>
    <SettingsRow title="Delete after">
      {#snippet control()}
        <div class="flex max-w-full items-center gap-2">
          <div class="w-44 max-w-full">
            <Input
              type="number"
              name="archivedThreadDays"
              aria-label="Days in archive"
              aria-describedby={id}
              aria-invalid={!valid || undefined}
              inputmode="numeric"
              min={1}
              max={36500}
              step={1}
              required={value.enabled}
              disabled={disabled || !value.enabled}
              bind:value={() => value.days, (days) => (draft = { ...value, days: days == null ? null : Number(days) })}
            />
          </div>
          <span class="text-sm/5 text-zinc-500 dark:text-zinc-400">days</span>
        </div>
      {/snippet}
    </SettingsRow>
    <div {id} class="grid gap-1 px-4 pb-4 text-sm/5 text-zinc-500 dark:text-zinc-400">
      <p>Workspace files stay unchanged.</p>
      <p>Deletion waits while forks still need a thread’s history.</p>
      <p class="min-h-5" role="status">{!valid ? "Enter a whole number from 1 to 36500 days, then save." : ""}</p>
      <div class="flex justify-end">
        <Button type="submit" loading={pending} disabled={disabled || !valid || days === saved}>Save</Button>
      </div>
    </div>
  </form>
</SettingsGroup>

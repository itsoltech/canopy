<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import { create } from "@bufbuild/protobuf";
  import { ui } from "@canopy/contracts";
  import { useSettings } from "#lib/features/settings/settings-state.svelte.ts";
  import { requestJson } from "#lib/shared/http.ts";
  import { encode } from "#lib/shared/wire.ts";
  import SettingsGroup from "#lib/shared/ui/SettingsGroup.svelte";
  import Field from "#lib/shared/ui/Field.svelte";
  import Input from "#lib/shared/ui/Input.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";

  let { class: className }: { class?: ClassValue } = $props();
  const settings = useSettings();

  const fields = [
    { key: "file", label: "Per file (MiB)", max: 30 },
    { key: "message", label: "Per message (MiB)", max: 1024 },
    { key: "files", label: "Files per message", max: 100 },
  ] as const;

  let values = $state({ file: 20, message: 50, files: 10 });
  let busy = $state(false);
  let error = $state("");
  let saved = $state(false);

  $effect(() => {
    const limits = settings.attachmentLimits;

    if (limits)
      values = {
        file: Number(limits.maxFileBytes) / 1024 ** 2,
        message: Number(limits.maxMessageBytes) / 1024 ** 2,
        files: limits.maxFiles,
      };
  });

  async function save() {
    busy = true;
    error = "";
    saved = false;

    try {
      await requestJson(
        "PUT",
        "/api/settings/user",
        encode(
          ui.UpdateUserSettingsRequestSchema,
          create(ui.UpdateUserSettingsRequestSchema, {
            expectedVersion: settings.user.version,
            attachmentLimits: {
              maxFileBytes: BigInt(Math.round(values.file * 1024 ** 2)),
              maxMessageBytes: BigInt(Math.round(values.message * 1024 ** 2)),
              maxFiles: values.files,
            },
          }),
        ),
      );
      await settings.reload();
      saved = true;
    } catch (e) {
      error = e instanceof Error ? e.message : "Could not save attachment limits";
      await settings.reload();
    } finally {
      busy = false;
    }
  }
</script>

<SettingsGroup
  title="Attachments"
  description="Limits apply to new uploads and messages on this computer."
  class={className}
>
  <form
    class="grid gap-4 p-4 sm:p-5"
    onsubmit={(e) => {
      e.preventDefault();
      void save();
    }}
  >
    <div class="grid gap-4 sm:grid-cols-3">
      {#each fields as field (field.key)}
        <Field label={field.label}
          ><Input
            type="number"
            name={`attachment-${field.key}`}
            min={1}
            max={field.max}
            step={1}
            required
            bind:value={values[field.key]}
            disabled={busy}
          /></Field
        >
      {/each}
    </div>
    {#if error}<Alert tone="error">{error}</Alert>{/if}
    <div class="flex flex-wrap items-center justify-end gap-3">
      {#if saved}<p role="status" class="text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
          Limits saved
        </p>{/if}
      <Button type="submit" size="sm" loading={busy} disabled={!settings.attachmentLimits}>Save limits</Button>
    </div>
  </form>
</SettingsGroup>

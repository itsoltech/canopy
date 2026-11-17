<script lang="ts">
  import { clone, equals } from "@bufbuild/protobuf";
  import { untrack } from "svelte";
  import { AgentTool, AgentToolSessionDefaultsSchema } from "@canopy/contracts";
  import { useSettings } from "#lib/features/settings/settings-state.svelte.ts";
  import Button from "#lib/shared/ui/Button.svelte";
  import Field from "#lib/shared/ui/Field.svelte";
  import Input from "#lib/shared/ui/Input.svelte";
  import BrowserDefaultsFields from "./BrowserDefaultsFields.svelte";
  import DeviceDefaultsFields from "./DeviceDefaultsFields.svelte";
  import { sessionDefaults } from "./session-defaults.ts";

  let { tool, name }: { tool: AgentTool; name: string } = $props();
  const settings = useSettings();
  const saved = $derived(sessionDefaults(settings.user.agentToolDefaults, tool));
  let baseline = $state.raw(untrack(() => saved));
  let draft = $state(untrack(() => clone(AgentToolSessionDefaultsSchema, baseline)));
  let saving = $state(false);
  let result = $state("");
  let error = $state("");
  const dirty = $derived(!equals(AgentToolSessionDefaultsSchema, draft, baseline));
  const empty = $derived(equals(AgentToolSessionDefaultsSchema, draft, sessionDefaults(undefined, tool)));

  $effect(() => {
    const next = saved;

    if (saving || error) return;
    untrack(() => {
      if (!equals(AgentToolSessionDefaultsSchema, baseline, next)) {
        if (equals(AgentToolSessionDefaultsSchema, draft, baseline))
          draft = clone(AgentToolSessionDefaultsSchema, next);
        baseline = next;
      }
    });
  });

  function reset() {
    draft = sessionDefaults(undefined, tool);
    error = "";
    result = "";
  }

  async function save() {
    const browser = draft.browser;
    const device = draft.device;

    if (browser && [browser.viewportWidth, browser.viewportHeight].some((value) => value != null)) {
      if (
        ![browser.viewportWidth, browser.viewportHeight].every(
          (value) => Number.isInteger(value) && Number(value) >= 320 && Number(value) <= 8192,
        )
      ) {
        error = "Enter a width and height from 320 to 8192 pixels.";

        return;
      }
    }

    if (
      device?.acquireTimeoutSeconds != null &&
      (!Number.isInteger(device.acquireTimeoutSeconds) ||
        device.acquireTimeoutSeconds < 1 ||
        device.acquireTimeoutSeconds > 240)
    ) {
      error = "Enter a device wait from 1 to 240 seconds.";

      return;
    }

    if (draft.desktop) draft.desktop.app = draft.desktop.app.trim();
    const submitted = clone(AgentToolSessionDefaultsSchema, draft);
    saving = true;
    error = "";
    result = "";

    try {
      const confirmed = await settings.updateAgentToolDefaults(submitted);

      if (confirmed) {
        baseline = submitted;
        result = "Defaults saved";
      } else error = "Could not save defaults. Retry saving.";
    } catch {
      error = "Could not save defaults. Retry saving.";
    } finally {
      saving = false;
    }
  }
</script>

<form
  class="grid gap-4 border-t border-zinc-950/5 px-4 py-4 sm:px-5 dark:border-white/8"
  aria-label={`${name} session defaults`}
  onsubmit={(event) => {
    event.preventDefault();
    void save();
  }}
>
  <div>
    <h2 class="text-sm/6 font-semibold text-zinc-950 dark:text-white">Session defaults</h2>
    <p class="text-sm/5 text-pretty text-zinc-500 dark:text-zinc-400">
      For new sessions on all workers. Agents can override these values.
    </p>
  </div>
  <fieldset disabled={saving || !settings.loaded} class="grid min-w-0 gap-4">
    {#if draft.browser}
      <BrowserDefaultsFields bind:value={draft.browser} />
    {:else if draft.desktop}
      <Field
        label="Default app"
        description="Used when no app or window is selected. Screen size follows the app or display."
      >
        <Input bind:value={draft.desktop.app} maxlength={200} placeholder="Safari" />
      </Field>
    {:else if draft.device}
      <DeviceDefaultsFields bind:value={draft.device} />
      <p class="text-sm/5 text-zinc-500 dark:text-zinc-400">Screen size follows the selected device.</p>
    {/if}
    <div class="flex flex-wrap items-center justify-between gap-3">
      <Button size="sm" disabled={empty} onclick={reset}>Reset defaults</Button>
      <Button size="sm" type="submit" variant="primary" loading={saving} disabled={!dirty}>Save defaults</Button>
    </div>
  </fieldset>
  <p
    class="min-h-5 text-sm/5 text-pretty"
    class:text-red-600={Boolean(error)}
    class:dark:text-red-400={Boolean(error)}
    class:text-zinc-500={!error}
    class:dark:text-zinc-400={!error}
    role="status"
  >
    {error || (dirty ? "Unsaved changes" : result)}
  </p>
</form>

<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import { normalizeColor } from "@canopy/ui/color";
  import { palette } from "@canopy/ui";
  import { projectMark } from "@canopy/ui/thread-row";
  import { requestJson } from "#lib/shared/http.ts";
  import Button from "#lib/shared/ui/Button.svelte";
  import CustomColorPicker from "#lib/shared/ui/CustomColorPicker.svelte";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import FieldError from "#lib/shared/ui/FieldError.svelte";
  import ProjectAvatar from "#lib/shared/ui/ProjectAvatar.svelte";
  import SettingsRow from "#lib/shared/ui/SettingsRow.svelte";
  import { toast } from "#lib/shared/ui/toast.svelte.ts";

  let { project }: { project: ui.Project } = $props();

  let open = $state(false);
  let saving = $state<"automatic" | "custom">();
  const busy = $derived(saving !== undefined);
  let draft = $state("");
  let error = $state<string>();
  const color = $derived(normalizeColor(draft));

  function edit() {
    const mark = projectMark(project.name);
    draft = project.color || palette[mark.tone][mark.fill];
    error = undefined;
    open = true;
  }

  async function save(next: string) {
    if (busy) return;
    saving = next ? "custom" : "automatic";
    error = undefined;

    try {
      await requestJson("PUT", `/api/projects/${encodeURIComponent(project.id)}/color`, { color: next });
      open = false;
      toast(next ? "Project color saved" : "Automatic color restored");
    } catch {
      error = "Could not save the project color. Try again.";
    } finally {
      saving = undefined;
    }
  }
</script>

<SettingsRow title="Project color" description={project.color || "Automatic"}>
  {#snippet control()}<Button onclick={edit}>Change color…</Button>{/snippet}
</SettingsRow>

<Dialog
  bind:open
  title="Change project color"
  description={project.imageBase64 ? "The color applies to the project’s initials." : undefined}
  dismissible={!busy}
>
  <form
    onsubmit={(event) => {
      event.preventDefault();

      if (color && color !== project.color) void save(color);
    }}
  >
    <div class="mb-3 flex min-w-0 items-center gap-2">
      <ProjectAvatar
        name={project.name}
        color={color ?? project.color}
        imageBase64={project.imageBase64}
        class="size-8 rounded-md text-xs/none"
      />
      <span class="min-w-0 truncate text-sm/6 font-medium" title={project.name}>{project.name}</span>
    </div>
    <CustomColorPicker bind:value={draft} disabled={busy} />
    <FieldError message={error} />
    <div class="mt-4 flex flex-wrap justify-between gap-2">
      <Button
        variant="ghost"
        icon="arrow-path"
        loading={saving === "automatic"}
        disabled={busy || !project.color}
        onclick={() => void save("")}
      >
        Use automatic color
      </Button>
      <Button
        type="submit"
        variant="primary"
        icon="check"
        disabled={busy || !color || color === project.color}
        loading={saving === "custom"}
      >
        Change color
      </Button>
    </div>
  </form>
</Dialog>

<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import { base64Encode } from "@bufbuild/protobuf/wire";
  import { requestJson } from "#lib/shared/http.ts";
  import Button from "#lib/shared/ui/Button.svelte";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import DialogActions from "#lib/shared/ui/DialogActions.svelte";
  import FieldError from "#lib/shared/ui/FieldError.svelte";
  import SettingsRow from "#lib/shared/ui/SettingsRow.svelte";
  import { toast } from "#lib/shared/ui/toast.svelte.ts";
  import ProjectImageCrop from "./ProjectImageCrop.svelte";

  let { project }: { project: ui.Project } = $props();

  const types = ["image/jpeg", "image/png", "image/webp"];
  const maxFileBytes = 10 * 1024 * 1024;
  const cropPixels = 384;
  let input = $state<HTMLInputElement>();
  let file = $state<File>();
  let cropOpen = $state(false);
  let removeOpen = $state(false);
  let saving = $state(false);
  let selectionError = $state<string>();
  let saveError = $state<string>();

  function choose(event: Event & { currentTarget: HTMLInputElement }) {
    const selected = event.currentTarget.files?.[0];
    event.currentTarget.value = "";

    if (!selected) return;

    if (selected.size > maxFileBytes || (selected.type && !types.includes(selected.type))) {
      selectionError = "Choose a JPEG, PNG or WebP image up to 10 MiB.";

      return;
    }

    selectionError = undefined;
    saveError = undefined;
    file = selected;
    cropOpen = true;
  }

  async function persist(image: string) {
    await requestJson("PUT", `/api/projects/${encodeURIComponent(project.id)}/image`, { image });
  }

  async function save(source: HTMLImageElement, x: number, y: number, size: number) {
    if (saving) return;
    saving = true;
    saveError = undefined;

    try {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = cropPixels;
      const context = canvas.getContext("2d");

      if (!context) throw new Error("Image canvas unavailable");
      context.imageSmoothingQuality = "high";
      context.drawImage(source, x, y, size, size, 0, 0, cropPixels, cropPixels);
      const image = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));

      if (!image) throw new Error("Could not encode crop");
      await persist(base64Encode(new Uint8Array(await image.arrayBuffer())));
      cropOpen = false;
      toast("Project image saved");
    } catch {
      saveError = "Could not save the project image. Try again.";
    } finally {
      saving = false;
    }
  }

  async function remove() {
    if (saving) return;
    saving = true;
    saveError = undefined;

    try {
      await persist("");
      removeOpen = false;
      toast("Project image removed");
    } catch {
      saveError = "Could not remove the project image. Try again.";
    } finally {
      saving = false;
    }
  }
</script>

<SettingsRow
  title="Project image"
  description={project.imageBase64 ? "Custom image" : "Project initials"}
  class="[&_.settings-row-control]:max-sm:self-end"
>
  <FieldError message={selectionError} class="mt-1" />
  {#snippet control()}
    <input type="file" accept={types.join(",")} bind:this={input} onchange={choose} hidden />
    {#if project.imageBase64}
      <Button
        variant="ghost"
        aria-label="Remove project image"
        onclick={() => {
          saveError = undefined;
          removeOpen = true;
        }}>Remove</Button
      >
    {/if}
    <Button onclick={() => input?.click()}>{project.imageBase64 ? "Change image" : "Upload image"}</Button>
  {/snippet}
</SettingsRow>

<Dialog
  bind:open={cropOpen}
  title="Crop project image"
  description="Drag the image or tap a point to center it."
  dismissible={!saving}
>
  {#if file}
    {#key file}
      <ProjectImageCrop {file} {saving} error={saveError} oncancel={() => (cropOpen = false)} onsave={save} />
    {/key}
  {/if}
</Dialog>

<Dialog
  bind:open={removeOpen}
  title="Remove project image?"
  description="The project returns to its initials."
  dismissible={!saving}
>
  <FieldError message={saveError} class="mb-3" />
  <DialogActions>
    <Button data-autofocus disabled={saving} onclick={() => (removeOpen = false)}>Cancel</Button>
    <Button variant="danger" loading={saving} onclick={() => void remove()}>Remove image</Button>
  </DialogActions>
</Dialog>

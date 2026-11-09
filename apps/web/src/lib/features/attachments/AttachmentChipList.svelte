<script lang="ts">
  import { create } from "@bufbuild/protobuf";
  import { MentionKind, MentionSchema, type ui } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import AttachmentChip from "./AttachmentChip.svelte";

  let { attachments, class: className }: { attachments: readonly ui.Attachment[]; class?: ClassValue } = $props();
</script>

<ul role="list" aria-label="Attachments" class={["flex min-w-0 flex-wrap gap-1", className]}>
  {#each attachments as file (file.id)}
    <li class="max-w-full min-w-0">
      <AttachmentChip
        {file}
        mention={create(MentionSchema, {
          kind: MentionKind.ATTACHMENT,
          name: file.id,
          label: file.name,
          source: file.kind,
        })}
      />
    </li>
  {/each}
</ul>

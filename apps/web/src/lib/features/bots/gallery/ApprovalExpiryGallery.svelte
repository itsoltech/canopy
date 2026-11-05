<script lang="ts">
  import { create } from "@bufbuild/protobuf";
  import { bots, InteractionKind, ui } from "@canopy/contracts";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import { approvalView } from "../live.ts";
  import ApprovalCard from "../components/ApprovalCard.svelte";
  import GallerySection from "./GallerySection.svelte";
  import InteractionCard from "#lib/features/threads/components/interactions/InteractionCard.svelte";

  const prompt = [
    "Move the work order tools into `packages/domain/src/work-orders/`.",
    "",
    "- Keep owner checks in the gateway.",
    "- Update `apps/gateway/src/core/work-orders.ts` and the shared contracts.",
    "- Preserve the existing approval policy.",
    "",
    "## Verification",
    "",
    "1. Run the gateway integration tests.",
    "2. Check the migration with an existing database.",
    "3. Report the changed files and remaining limitations.",
    "",
    "Keep this paragraph intact: labels inside the prompt, such as Prompt: and Title:, must remain part of the markdown rather than becoming new approval fields.",
  ].join("\n");

  const approval = approvalView(
    create(bots.BotApprovalSchema, {
      id: "expiry-fixture",
      botId: "fixture",
      status: "pending",
      prompt: "Needs approval · Starting a work order thread",
      fields: [
        { label: "Workspace mode", value: "new_worktree" },
        { label: "Base ref", value: "origin/feature/work-orders-mcp-with-owner-scoped-approval-and-long-reference" },
        { label: "Permission", value: "full_auto" },
        { label: "Title", value: "Move work order tools into shared domain modules" },
        { label: "Prompt", value: prompt },
      ],
    }),
  );

  let raced = $state(false);
</script>

<div id="approval-expiry">
  <GallerySection
    title="Approval expiry"
    description="Long values, a resolved request and a click that reaches an expired request."
  >
    <div class="grid max-w-xl gap-4">
      <ApprovalCard {approval} onanswer={() => {}} />
      <ApprovalCard approval={{ ...approval, id: "expired-fixture", status: "expired" }} />
      <ApprovalCard
        approval={{ ...approval, id: "race-fixture", status: raced ? "expired" : "pending" }}
        onanswer={() => (raced = true)}
      />
      {#if raced}<Alert tone="info">This request expired. No answer was sent.</Alert>{/if}
      <InteractionCard
        interaction={create(ui.InteractionSchema, {
          requestId: "thread-expired-fixture",
          status: "expired",
          kind: InteractionKind.PERMISSION,
          toolName: "create_thread",
          requestJson: JSON.stringify({
            workspace_mode: "new_worktree",
            base_ref: approval.fields[1]!.value,
            prompt,
          }),
        })}
        related={undefined}
      />
    </div>
  </GallerySection>
</div>

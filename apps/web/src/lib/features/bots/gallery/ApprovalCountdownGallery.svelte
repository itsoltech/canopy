<script lang="ts">
  import { create } from "@bufbuild/protobuf";
  import { timestampFromDate } from "@bufbuild/protobuf/wkt";
  import { InteractionKind, ui } from "@canopy/contracts";
  import Button from "#lib/shared/ui/Button.svelte";
  import ApprovalCard from "../components/ApprovalCard.svelte";
  import QuestionCard from "../components/QuestionCard.svelte";
  import InteractionCard from "#lib/features/threads/components/interactions/InteractionCard.svelte";
  import GallerySection from "./GallerySection.svelte";
  import type { ApprovalView } from "../model.ts";

  let expiresAt = $state(new Date(Date.now() + 35_000));
  let expired = $state(false);

  const approval = $derived<ApprovalView>({
    id: "countdown-approval",
    askedBy: "fixture",
    at: new Date(0),
    expiresAt,
    action: "Start a work order thread",
    status: expired ? "expired" : "pending",
    fields: [
      { label: "Base ref", value: "origin/feature/work-orders-mcp-with-owner-scoped-approval-and-long-reference" },
      {
        label: "Prompt",
        value:
          "Move tools into `packages/domain/src/work-orders/`.\n\n- Keep owner checks.\n- Preserve approvals.\n\n## Verification\n\n1. Run integration tests.\n2. Check the migration.\n\nReport the changed files and any remaining limitations.",
      },
    ],
  });

  $effect(() => {
    const timer = setTimeout(() => (expired = true), Math.max(0, expiresAt.getTime() - Date.now() + 2500));

    return () => clearTimeout(timer);
  });

  function restart(seconds: number) {
    expired = false;
    expiresAt = new Date(Date.now() + seconds * 1000);
  }
</script>

<div id="approval-countdown">
  <GallerySection
    title="Approval countdown"
    description="A known deadline, followed by a separate simulated gateway expiry event."
  >
    <div class="grid max-w-xl gap-4">
      <div class="flex flex-wrap gap-2">
        <Button size="sm" onclick={() => restart(35)}>Start countdown</Button>
        <Button size="sm" onclick={() => restart(3)}>Show expiry</Button>
      </div>
      <ApprovalCard {approval} onanswer={() => {}} />
      <QuestionCard
        question={{
          id: "countdown-question",
          askedBy: "fixture",
          at: new Date(0),
          expiresAt,
          expired,
          prompt: "Which base ref should the thread use?",
          options: [{ id: "dev", label: "origin/dev" }],
          freeText: true,
        }}
        onanswer={() => {}}
      />
      <InteractionCard
        interaction={create(ui.InteractionSchema, {
          requestId: "countdown-thread",
          kind: InteractionKind.PERMISSION,
          status: expired ? "expired" : "pending",
          toolName: "shell",
          requestJson: JSON.stringify({ command: "bun run typecheck" }),
          expiresAt: timestampFromDate(expiresAt),
        })}
        related={undefined}
      />
    </div>
  </GallerySection>
</div>

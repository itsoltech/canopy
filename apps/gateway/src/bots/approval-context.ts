import type { bots } from "@canopy/contracts";
import { BOT_APPROVAL_OPTIONS } from "@canopy/domain/bot-chat";

/** Describe gateway policy with the same labels the owner sees in bot settings. */
export function botApprovalContext(config: bots.BotConfiguration): string {
  const approval =
    BOT_APPROVAL_OPTIONS.find((option) => option.value === config.approvalPolicy) ?? BOT_APPROVAL_OPTIONS[0]!;

  return `Canopy Permissions → Ask for approval: ${approval.label}. ${approval.description} Canopy's gateway enforces these approvals and Allowed actions. Threads started by this bot controls coding thread permissions separately. Native harness approval settings are internal, not bot settings. If a Canopy tool is blocked by a native approval policy, report a worker configuration problem; do not suggest a nonexistent bot setting.`;
}

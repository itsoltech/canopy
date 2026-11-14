import type { Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { create } from "@bufbuild/protobuf";
import { timestampFromDate, timestampNow } from "@bufbuild/protobuf/wkt";
import { ProviderUsageSnapshotSchema, type ProviderUsageSnapshot } from "@canopy/contracts";
import { sanitizeProviderUsage } from "@canopy/domain/provider-usage";
import { claudeUsage, claudeUsageNotification } from "../usage-limits.ts";

/** One account per runtime; concurrent threads share the latest windows and the rare SDK read. */
export class ClaudeUsage {
  #snapshot: ProviderUsageSnapshot | undefined;
  #revision = 0;
  #readAt = 0;

  constructor(
    readonly publish: ((snapshot: ProviderUsageSnapshot) => void) | undefined,
    snapshot?: ProviderUsageSnapshot,
  ) {
    this.#snapshot = snapshot;
  }

  observe(message: SDKMessage, query?: Query): boolean {
    if (!this.publish) return false;

    if (message.type === "system" && message.subtype === "init") void this.read(query);
    const previous = this.#snapshot;

    const next =
      message.type === "rate_limit_event"
        ? claudeUsage(message.rate_limit_info, previous)
        : claudeUsageNotification(message, previous);

    if (!next) return false;
    this.#revision++;
    this.#snapshot = next;
    this.publish(next);

    return previous?.usingExtraUsage !== true && next.usingExtraUsage === true;
  }

  async read(query: Query | undefined): Promise<void> {
    if (!query || !this.publish || Date.now() - this.#readAt < 15 * 60_000) return;
    this.#readAt = Date.now();
    const revision = this.#revision;

    try {
      const result = await query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true });

      if (!result.rate_limits_available || !result.rate_limits || revision !== this.#revision) return;
      const limits = result.rate_limits;

      const windows = (["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet"] as const).flatMap((key) => {
        const window = limits[key];

        if (!window) return [];
        const date = window.resets_at ? new Date(window.resets_at) : undefined;

        return [
          {
            key,
            usedPercent: window.utilization ?? undefined,
            resetsAt: date && Number.isFinite(date.getTime()) ? timestampFromDate(date) : undefined,
            reached: (window.utilization ?? 0) >= 100,
          },
        ];
      });

      this.#snapshot = sanitizeProviderUsage(
        create(ProviderUsageSnapshotSchema, {
          windows,
          observedAt: timestampNow(),
          creditsAvailable: limits.extra_usage?.is_enabled,
          usingExtraUsage: this.#snapshot?.usingExtraUsage,
        }),
      );
      this.publish(this.#snapshot);
    } catch {
      // Optional, experimental control method: older CLIs can still report rate_limit_event.
    }
  }
}

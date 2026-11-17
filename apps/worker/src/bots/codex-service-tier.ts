import { Effect } from "effect";
import type { v2 } from "@canopy/codex-protocol";
import type { CodexAppServer } from "../providers/codex/app-server.ts";
import { BotHarnessFailure } from "./types.ts";

/** Recheck this process's account catalog immediately before admitting a bot turn. */
export function verifyCodexBotTier(server: CodexAppServer["Service"], model: string, serviceTier: string) {
  return Effect.gen(function* () {
    if (!serviceTier || serviceTier === "default") return;
    let cursor: string | null = null;

    do {
      const page: v2.ModelListResponse = yield* server.request("model/list", {
        includeHidden: true,
        ...(cursor && { cursor }),
      });

      const listed = page.data.find((m) => m.model === model || m.id === model);

      if (listed?.serviceTiers?.some((tier) => tier.id === serviceTier)) return;

      if (listed) break;
      cursor = page.nextCursor;
    } while (cursor);

    return yield* Effect.fail(
      new BotHarnessFailure(
        "SERVICE_TIER_UNAVAILABLE",
        "The selected speed is unavailable for this model and account.",
      ),
    );
  }).pipe(
    Effect.mapError(
      () =>
        new BotHarnessFailure(
          "SERVICE_TIER_UNAVAILABLE",
          "The selected speed is unavailable for this model and account.",
        ),
    ),
  );
}

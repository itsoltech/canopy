import type { RunBotTurn } from "@canopy/contracts";
import type { ThreadEventInit, TurnHarness } from "../journal/index.ts";
import type { ResolvedProfile } from "../providers/profiles.ts";
import type { BotSession } from "./session.ts";

/** Stable harness code only; provider payloads and stderr never enter gateway-visible reasons. */
export class BotHarnessFailure extends Error {
  constructor(
    readonly code: string,
    message = "Bot harness could not finish this turn",
  ) {
    super(message);
  }
}

export interface BotHarnessContext {
  input: RunBotTurn;
  session: BotSession;
  profile: ResolvedProfile;
  executable: string;
  signal: AbortSignal;
  clientVersion: string;
  mcp: { url: string; headers: Record<string, string> };
  record(event: ThreadEventInit): Promise<void>;
  noteHarness(harness: TurnHarness): Promise<void>;
}

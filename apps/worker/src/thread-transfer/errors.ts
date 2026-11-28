import { CommandError } from "../runtime/host-types.ts";

/** A refusal whose message is safe to show to the owner (no file contents, no credentials). */
export const transferError = (message: string) => new CommandError("THREAD_TRANSFER_FAILED", message, false);

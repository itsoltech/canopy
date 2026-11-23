/** Fixed worker diagnostics safe to show in the account report and on a failed turn. */
export const codexLoginProblems = {
  link: "Canopy could not link the Codex login. For threads, select Use CLI home on this instance.",
  windows: "Windows could not link the Codex login. For threads, select Use CLI home on this instance.",
  lock: "Could not share the Codex login lock. For threads, select Use CLI home or check the private directory.",
} as const;

// Older workers report these fixed messages before negotiating the CLI home option.
const previousWindowsProblem = "Canopy could not use the device login. Enable Windows Developer Mode to share it.";
const previousLockProblem = "Could not share the Codex login lock. Check the instance home and its permissions.";

export function codexLoginProblem(message: string): string | undefined {
  if (message === previousWindowsProblem) return codexLoginProblems.windows;

  if (message === previousLockProblem) return codexLoginProblems.lock;

  // The gateway prefixes the reason when thread creation fails before a queued turn starts.
  return Object.values(codexLoginProblems).find((detail) => message === detail || message.endsWith(`: ${detail}`));
}

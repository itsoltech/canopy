export interface WorkFoldPreferences {
  readonly expandWhileWorking: boolean;
  readonly keepAfterTurn: boolean;
}

/** Manual choices and an active reader take precedence over device defaults. */
export function workFoldOpen(
  live: boolean,
  answerStarted: boolean,
  preferences: WorkFoldPreferences,
  manual?: boolean,
  reading = false,
): boolean {
  return manual ?? (reading || (live && !answerStarted ? preferences.expandWhileWorking : preferences.keepAfterTurn));
}

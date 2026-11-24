const visitedScopes = new Set<string>();
const storageKey = (scope: string) => `canopy:last-opened-bot:${scope}`;

/** The landing page may attempt restoration once per gateway in this app session. */
export function takeLastOpenedBot(scope: string): string | undefined {
  if (visitedScopes.has(scope)) return;
  visitedScopes.add(scope);

  try {
    return localStorage.getItem(storageKey(scope)) ?? undefined;
  } catch {
    return undefined;
  }
}

export function rememberOpenedBot(scope: string, botId: string): void {
  visitedScopes.add(scope);

  try {
    localStorage.setItem(storageKey(scope), botId);
  } catch {
    // Navigation still works in profiles that deny local storage.
  }
}

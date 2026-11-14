/** Explicit HTML consent and measured geometry survive virtualized rows, only for this pairing/session. */
const entries = new Map<string, { run: boolean; height: number }>();
const key = (id: string, version: number) => `${id}@${version}`;

export function visualSession(id: string, version: number) {
  return entries.get(key(id, version));
}

export function rememberVisualSession(id: string, version: number, change: { run?: boolean; height?: number }) {
  const name = key(id, version);
  entries.set(name, { run: false, height: 0, ...entries.get(name), ...change });
}

export function clearVisualSession() {
  entries.clear();
}

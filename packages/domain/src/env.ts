type EnvSource = Readonly<Record<string, string | undefined>>;

/**
 * Reader of CANOPY_* configuration. A variable from before the rename (OA_X for CANOPY_X) is used when the new one
 * is unset; the first such read logs one deprecation warning per process (docs/deploy.md, "Zmienne środowiskowe").
 */
export function legacyEnvReader(warn: (message: string) => void = (message) => console.warn(message)) {
  let warned = false;
  return (name: `CANOPY_${string}`, source: EnvSource = process.env): string | undefined => {
    const value = source[name];
    if (value !== undefined) return value;
    const legacy = `OA_${name.slice("CANOPY_".length)}`;
    const old = source[legacy];
    if (old !== undefined && !warned) {
      warned = true;
      warn(`${legacy} is deprecated, set ${name} instead (every OA_* variable is now CANOPY_*, see docs/deploy.md)`);
    }
    return old;
  };
}

export const readEnv = legacyEnvReader();

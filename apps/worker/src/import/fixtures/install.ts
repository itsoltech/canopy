import { cpSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Installs the generated CLI homes (`homes/<cli>/<version>/.<cli>`, see generate.ts) into a test HOME: the
 * fixture's `/home/user` becomes `home` in file contents and names, and the fixture's working directories exist.
 */

export const FIXTURE_HOME = "/home/user";
export const FIXTURE_VERSIONS = { claude: "2.1.308", codex: "0.164.0", grok: "1.0.70" } as const;

export type FixtureCli = keyof typeof FIXTURE_VERSIONS;

export function installFixtureHome(home: string, clis: readonly FixtureCli[] = ["claude", "codex", "grok"]): void {
  const forms = (to: string): [string, string][] => [
    [FIXTURE_HOME, to],
    [FIXTURE_HOME.replace(/[^a-zA-Z0-9]/g, "-"), to.replace(/[^a-zA-Z0-9]/g, "-")],
    [encodeURIComponent(FIXTURE_HOME), encodeURIComponent(to)],
  ];

  const swap = (text: string) => forms(home).reduce((t, [from, to]) => t.split(from).join(to), text);

  for (const cli of clis) {
    const target = join(home, `.${cli}`);
    cpSync(join(import.meta.dir, "homes", cli, FIXTURE_VERSIONS[cli], `.${cli}`), target, { recursive: true });
    rewrite(target, swap);
  }

  for (const dir of ["project", "other"]) mkdirSync(join(home, dir), { recursive: true });
}

function rewrite(dir: string, swap: (text: string) => string): void {
  for (const entry of readdirSync(dir)) {
    const renamed = join(dir, swap(entry));

    if (renamed !== join(dir, entry)) renameSync(join(dir, entry), renamed);

    if (statSync(renamed).isDirectory()) rewrite(renamed, swap);
    else writeFileSync(renamed, swap(readFileSync(renamed, "utf8")));
  }
}

/** Contents and modification times of every file under `dir`: equal before and after = nothing was written. */
export function treeFingerprint(dir: string): string {
  const hash = new Bun.CryptoHasher("sha256");

  const walk = (path: string) => {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = join(path, entry.name);
      const stat = statSync(child);
      hash.update(`${child}\0${stat.mtimeMs}\0${stat.size}\0`);

      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) hash.update(readFileSync(child));
    }
  };

  walk(dir);

  return hash.digest("hex");
}

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

const IMMUTABLE = "_app/immutable";

function immutableFiles(client: string): string[] {
  return readdirSync(join(client, IMMUTABLE), { recursive: true, encoding: "utf8" })
    .filter((file) => !/\.(gz|br)$/.test(file) && statSync(join(client, IMMUTABLE, file)).isFile())
    .map((file) => `${IMMUTABLE}/${file}`);
}

/** Copy before adapter-node measures its static asset table; copying into `out` afterwards gives 404s. */
export function retainImmutable(client: string, previous: readonly string[]): string[] {
  const own = immutableFiles(client);

  for (const release of previous) {
    // Each manifest lists only that release's own assets, so retention does not grow forever.
    const manifest = join(release, "immutable-files.json");

    const files = existsSync(manifest)
      ? (JSON.parse(readFileSync(manifest, "utf8")) as string[])
      : immutableFiles(join(release, "client"));

    for (const file of files) {
      if (!file.startsWith(`${IMMUTABLE}/`) || file.split(/[\\/]/).includes(".."))
        throw new Error("Invalid immutable asset path");
      const target = join(client, file);

      if (existsSync(target)) continue;
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(join(release, "client", file), target);
    }
  }

  return own;
}

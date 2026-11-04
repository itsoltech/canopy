import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { retainImmutable } from "../scripts/release-assets.ts";

test("retains only the selected generations, preserves current hashes and records only native files", () => {
  const root = mkdtempSync(join(import.meta.dir, ".release-test-"));

  try {
    const client = join(root, "new/client");
    const old = join(root, "old");

    for (const dir of [client, join(old, "client")]) mkdirSync(join(dir, "_app/immutable/chunks"), { recursive: true });
    writeFileSync(join(client, "_app/immutable/chunks/shared.js"), "new");
    writeFileSync(join(old, "client/_app/immutable/chunks/shared.js"), "old");
    writeFileSync(join(old, "client/_app/immutable/chunks/retained.js"), "retained");
    writeFileSync(join(old, "client/_app/immutable/chunks/expired.js"), "expired");
    writeFileSync(
      join(old, "immutable-files.json"),
      JSON.stringify(["_app/immutable/chunks/shared.js", "_app/immutable/chunks/retained.js"]),
    );
    const own = retainImmutable(client, [old]);
    expect(own).toEqual(["_app/immutable/chunks/shared.js"]);
    expect(readFileSync(join(client, "_app/immutable/chunks/shared.js"), "utf8")).toBe("new");
    expect(readFileSync(join(client, "_app/immutable/chunks/retained.js"), "utf8")).toBe("retained");
    expect(() => readFileSync(join(client, "_app/immutable/chunks/expired.js"))).toThrow();
    rmSync(join(old, "immutable-files.json"));
    // The first release also accepts a legacy adapter-node build without a retention manifest.
    retainImmutable(client, [old]);
    expect(readFileSync(join(client, "_app/immutable/chunks/expired.js"), "utf8")).toBe("expired");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

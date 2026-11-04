const { createHash } = require("node:crypto");
const { existsSync, lstatSync, readFileSync, readdirSync, rmSync, symlinkSync } = require("node:fs");
const { execFileSync } = require("node:child_process");
const { dirname, isAbsolute, join, relative, resolve } = require("node:path");

// npm cannot preserve symlinks in tarballs. The distribution records the aliases,
// but some versions also publish dereferenced copies at those paths. Replace both.
function restorePostgresLinks(directory) {
  const manifest = join(directory, "pg-symlinks.json");

  if (!existsSync(manifest)) return;

  const inside = (path) => {
    const result = resolve(directory, relative("native", path));
    const local = relative(directory, result);

    if (!local || local.startsWith("..") || isAbsolute(local)) throw new Error(`Invalid PostgreSQL alias: ${path}`);

    return result;
  };

  for (const { source, target } of JSON.parse(readFileSync(manifest, "utf8"))) {
    const original = inside(source);
    const alias = inside(target);

    if (!lstatSync(original).isFile()) throw new Error(`PostgreSQL alias source is not a file: ${source}`);
    rmSync(alias, { force: true });
    symlinkSync(relative(dirname(alias), original), alias);
  }
}

// Pinned releases may ship an empty alias manifest and publish every library alias
// (libicudata.dylib, .77.dylib, .77.1.dylib) as a full copy. Link identical copies to
// the most specific name, as the upstream build has them.
function linkDuplicateLibraries(directory) {
  const library = /^(.+?)((?:\.\d+)*\.(?:dylib|so)(?:\.\d+)*)$/;
  const lib = join(directory, "lib");

  if (!existsSync(lib)) return;
  const families = new Map();

  for (const entry of readdirSync(lib, { withFileTypes: true })) {
    const match = entry.isFile() && library.exec(entry.name);

    if (!match) continue;
    const kind = entry.name.includes(".dylib") ? "dylib" : "so";
    const key = `${match[1]}:${kind}`;
    families.set(key, [...(families.get(key) ?? []), entry.name]);
  }

  const digest = (name) =>
    createHash("sha256")
      .update(readFileSync(join(lib, name)))
      .digest("hex");

  for (const names of families.values()) {
    if (names.length < 2) continue;
    const original = names.reduce((best, name) => (name.length > best.length ? name : best));
    const hash = digest(original);

    for (const name of names) {
      if (name === original || digest(name) !== hash) continue;
      rmSync(join(lib, name));
      symlinkSync(original, join(lib, name));
    }
  }
}

function preparePostgres(directory, target) {
  // Shared libraries, SQL extensions, locales and all licenses remain intact.
  function removeBuildInputs(path) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const file = join(path, entry.name);

      if (entry.name === "include" || entry.name.endsWith(".a")) rmSync(file, { recursive: true, force: true });
      else if (entry.isDirectory()) removeBuildInputs(file);
    }
  }

  removeBuildInputs(directory);

  if (!target.startsWith("win32")) {
    restorePostgresLinks(directory);
    linkDuplicateLibraries(directory);
  }

  if (target.startsWith("darwin")) {
    const { machOFiles, thinMachOFilesPortable } = require("./macho.cjs");
    thinMachOFilesPortable(directory, target.split("-")[1]);

    // These are standalone children, not plugins loaded into hardened Bun. They
    // need no JIT entitlement or inherited Developer ID. Re-sign after thinning.
    // codesign ships with macOS; unlike lipo this does not require Xcode/CLT.
    for (const binary of machOFiles(directory)) {
      execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", "--timestamp=none", binary], {
        stdio: "pipe",
        timeout: 5000,
      });
      execFileSync("/usr/bin/codesign", ["--verify", "--strict", binary], { stdio: "pipe", timeout: 5000 });
    }
  }
}

module.exports = { restorePostgresLinks, linkDuplicateLibraries, preparePostgres };

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
  if (!target.startsWith("win32")) restorePostgresLinks(directory);
  if (target.startsWith("darwin")) {
    const { machOFiles, thinMachOFilesPortable } = require("./macho.cjs");
    thinMachOFilesPortable(directory, target.split("-")[1]);
    // These are standalone children, not plugins loaded into hardened Bun. They
    // need no JIT entitlement or inherited Developer ID. Re-sign after thinning.
    // codesign ships with macOS; unlike lipo this does not require Xcode/CLT.
    for (const binary of machOFiles(directory)) {
      execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", "--timestamp=none", binary], { stdio: "pipe", timeout: 5000 });
      execFileSync("/usr/bin/codesign", ["--verify", "--strict", binary], { stdio: "pipe", timeout: 5000 });
    }
  }
}
module.exports = { restorePostgresLinks, preparePostgres };

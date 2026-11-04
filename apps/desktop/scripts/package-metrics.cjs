const { createHash } = require("node:crypto");
const { closeSync, openSync, readSync, readdirSync, lstatSync } = require("node:fs");
const { basename, join, relative } = require("node:path");
const MiB = 1024 ** 2;

function files(directory) {
  const result = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) result.push(...files(path));
    else if (entry.isFile()) result.push({ path, size: lstatSync(path).size });
  }

  return result;
}

function digest(path) {
  const hash = createHash("sha256"),
    fd = openSync(path, "r"),
    buffer = Buffer.alloc(MiB);

  try {
    for (let count; (count = readSync(fd, buffer, 0, buffer.length, null));) hash.update(buffer.subarray(0, count));
  } finally {
    closeSync(fd);
  }

  return hash.digest("hex");
}

function assertNoAgentClis(entries) {
  for (const { path } of entries) {
    if (
      /^(?:claude|codex|grok)(?:\.exe)?$/i.test(basename(path)) ||
      /[/\\](?:claude-agent-sdk-(?:linux|darwin|win32)[^/\\]*|claude-code|codex-(?:linux|darwin|win32)[^/\\]*)[/\\]/.test(
        path,
      )
    )
      throw new Error(`Agent CLI must not be packaged: ${path}`);
  }
}

function packageMetrics(application, resources, target) {
  const entries = files(application);
  assertNoAgentClis(entries);
  const buckets = { shell: 0, asar: 0, bun: 0, sidecars: 0, nodeModules: 0, web: 0, other: 0 };
  const sizes = new Map();

  for (const entry of entries) {
    const path = relative(resources, entry.path).split("\\").join("/");

    const bucket = path.startsWith("../")
      ? "shell"
      : path === "app.asar"
        ? "asar"
        : /^runtime\/bun(?:\.exe)?$/.test(path)
          ? "bun"
          : /^runtime\/canopy-.+\.js$/.test(path)
            ? "sidecars"
            : path.startsWith("runtime/node_modules/")
              ? "nodeModules"
              : path.startsWith("runtime/web/")
                ? "web"
                : "other";

    buckets[bucket] += entry.size;

    if (entry.size >= 8 * MiB) {
      const same = sizes.get(entry.size) ?? [];
      same.push(entry);
      sizes.set(entry.size, same);
    }

    if (/^runtime\/canopy-.+\.js$/.test(path) && entry.size > 8 * MiB)
      throw new Error(`Sidecar bundle unexpectedly large: ${path}`);
  }

  for (const group of sizes.values()) {
    if (group.length < 2) continue;
    const hashes = new Map();

    for (const entry of group) {
      const hash = digest(entry.path);

      if (hashes.has(hash)) throw new Error(`Duplicate large packaged files: ${hashes.get(hash)}, ${entry.path}`);
      hashes.set(hash, entry.path);
    }
  }

  const total = Object.values(buckets).reduce((sum, bytes) => sum + bytes, 0);
  const budget = { "linux-x64": 550, "linux-arm64": 550, "darwin-arm64": 600, "win32-x64": 650 }[target];

  if (!budget) throw new Error(`No package size budget for ${target}`);

  if (total > budget * MiB)
    throw new Error(`Packaged ${target} app is ${(total / MiB).toFixed(1)} MiB; budget ${budget} MiB`);

  if (
    buckets.asar > 5 * MiB ||
    buckets.sidecars > 25 * MiB ||
    buckets.nodeModules > 35 * MiB ||
    buckets.bun > 130 * MiB
  )
    throw new Error("Desktop component exceeds its size budget; check bundled dependencies/runtime duplication");

  return { target, unit: "bytes", total, budget: budget * MiB, ...buckets };
}

module.exports = { files, assertNoAgentClis, packageMetrics };

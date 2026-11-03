import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { dump, load } from "js-yaml";
import { desktopIdentity } from "../src/identity.ts";

interface Feed {
  version: string;
  files: { url: string; sha512: string; size?: number }[];
  path: string;
  sha512: string;
  releaseDate?: string;
}

// Every macOS runner emits <channel>-mac.yml (only arm64 today). Merge their files arrays
// instead of allowing download-artifact's last writer to remove an architecture.
export async function mergeDesktopUpdates(source: string, destination: string, channel: string, version: string) {
  const identity = desktopIdentity(channel);
  const feeds = new Map<string, Feed>();
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) throw new Error(`Expected an artifact directory: ${entry.name}`);
    const directory = join(source, entry.name);
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      if (name.endsWith(".yml")) {
        if (!new RegExp(`^${identity.feed}(-mac|-linux(-arm64)?)?\\.yml$`).test(name)) throw new Error(`Unexpected update channel: ${name}`);
        const feed = load(readFileSync(path, "utf8")) as Feed;
        if (feed.version !== version || !Array.isArray(feed.files) || !feed.files.length) throw new Error(`Invalid feed: ${name}`);
        for (const file of feed.files) {
          if (basename(file.url) !== file.url || !file.url.startsWith(`${identity.artifactPrefix}-${version}-`)) throw new Error(`Invalid update filename: ${file.url}`);
          const asset = join(directory, file.url);
          const hash = createHash("sha512");
          for await (const chunk of Bun.file(asset).stream()) hash.update(chunk);
          if (hash.digest("base64") !== file.sha512) throw new Error(`Invalid update checksum: ${file.url}`);
        }
        const existing = feeds.get(name);
        if (existing) {
          for (const file of feed.files) {
            if (existing.files.some((other) => other.url === file.url)) throw new Error(`Duplicate update asset: ${file.url}`);
            existing.files.push(file);
          }
        } else feeds.set(name, feed);
      } else {
        if (!name.startsWith(`${identity.artifactPrefix}-${version}-`) || !/\.(AppImage|deb|dmg|zip|exe)(\.blockmap)?$/.test(name)) throw new Error(`Unexpected desktop asset: ${name}`);
        const output = join(destination, name);
        if (existsSync(output)) throw new Error(`Duplicate desktop asset: ${name}`);
        copyFileSync(path, output);
      }
    }
  }
  for (const [name, feed] of feeds) writeFileSync(join(destination, name), dump(feed, { lineWidth: -1 }));
}

if (import.meta.main) {
  const [source, destination] = process.argv.slice(2);
  const version = process.env["CANOPY_VERSION"];
  const channel = process.env["CANOPY_CHANNEL"];
  if (!source || !destination || !version || !channel) throw new Error("Usage: CANOPY_CHANNEL=… CANOPY_VERSION=… bun merge-update-metadata.ts <artifacts> <assets>");
  await mergeDesktopUpdates(resolve(source), resolve(destination), channel, version);
}

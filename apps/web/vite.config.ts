import tailwindcss from "@tailwindcss/vite";
import adapter from "@sveltejs/adapter-node";
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildVersion } from "./scripts/build-version.ts";
import { retainImmutable, stringList } from "./scripts/release-assets.ts";

const out = process.env["BUILD_DIR"] || "build";
const node = adapter({ out });
const version = (process.env["WEB_BUILD_VERSION"] ??= buildVersion());

// The Canopy version (scripts/version.ts, docs/release.md), shown in Settings and by /api/health.
const canopyVersion = process.env["CANOPY_VERSION"] || "0.0.0-dev";

export default defineConfig({
  plugins: [
    tailwindcss(),
    sveltekit({
      compilerOptions: {
        // Runes everywhere in this app (libraries keep their own mode).
        runes: ({ filename }) => (filename.split(/[/\\]/).includes("node_modules") ? undefined : true),
      },
      version: { name: version, pollInterval: 60_000 },
      adapter: {
        ...node,
        async adapt(builder) {
          const previous = stringList(process.env["WEB_PREVIOUS_RELEASES"] ?? "[]");
          const own = retainImmutable(builder.getClientDirectory(), previous);
          await node.adapt(builder);
          writeFileSync(join(out, "immutable-files.json"), JSON.stringify(own));
        },
      },
    }),
  ],
  define: { "process.env.CANOPY_VERSION": JSON.stringify(canopyVersion) },
  server: { port: 5173, strictPort: true },
});

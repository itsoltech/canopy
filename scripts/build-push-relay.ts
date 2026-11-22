import { join } from "node:path";
import { bunNotices, bunRuntimeNotice, mergeNotices, noticesText } from "./open-source-licenses.ts";

const outdir = process.argv[2];

if (!outdir) throw new Error("Usage: bun scripts/build-push-relay.ts <output-directory>");

const bundle = await Bun.build({
  target: "bun",
  entrypoints: ["apps/push-relay/src/main.ts"],
  outdir,
  naming: "relay.js",
  metafile: true,
});

const licenses = mergeNotices([bunRuntimeNotice()], bunNotices(bundle));

await Bun.write(join(outdir, "THIRD_PARTY_NOTICES.txt"), noticesText(licenses));

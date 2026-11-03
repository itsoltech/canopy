/** CI entry point: bootstrap is explicit; tag creation does not start another Actions run. */
import { appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import semanticRelease from "semantic-release";

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const output = (values) => {
  const lines = Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n");
  appendFileSync(process.env.GITHUB_OUTPUT, `${lines}\n`);
  console.log(lines);
};
const sha = git("rev-parse", "HEAD");
if (process.env.EXPECTED_SHA && sha !== process.env.EXPECTED_SHA) throw new Error("Branch moved since promotion; refusing a different commit");

if (process.env.GITHUB_REF_TYPE === "tag") {
  const tag = process.env.GITHUB_REF_NAME;
  if (!/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag)) throw new Error("Manual tags must be stable vX.Y.Z");
  git("merge-base", "--is-ancestor", sha, "origin/main");
  output({ published: true, version: tag.slice(1), tag, channel: "stable" });
} else if (!git("tag", "--merged", "HEAD", "--list", "v*").split("\n").some((tag) => /^v\d+\.\d+\.\d+$/.test(tag))) {
  console.log("No stable bootstrap tag: push v0.1.0 before automatic releases.");
  output({ published: false });
} else {
  const result = await semanticRelease();
  if (!result) output({ published: false });
  else {
    const { version, gitTag: tag } = result.nextRelease;
    output({ published: true, version, tag, channel: version.includes("-nightly.") ? "nightly" : version.includes("-beta.") ? "beta" : "stable" });
  }
}

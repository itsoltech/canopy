import { api, pages, repository } from "./release-github.ts";

const repo = repository();
const releases = pages<{ id: number; tag_name: string; draft: boolean; prerelease: boolean; published_at: string; assets: { name: string }[] }>(`repos/${repo}/releases?per_page=100`)
  .filter((release) => !release.draft && release.prerelease && /^v\d+\.\d+\.\d+-nightly\.\d+$/.test(release.tag_name) && release.assets.some((asset) => asset.name === "manifest.json"))
  .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at));
for (const release of releases.slice(10)) {
  api(`repos/${repo}/releases/${release.id}`, "DELETE");
  // Keep git tags: semantic-release needs prerelease counters and channel history even after asset expiry.
  console.log(`Pruned nightly release ${release.tag_name}; git tag retained`);
}

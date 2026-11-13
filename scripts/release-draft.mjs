import { execFileSync } from "node:child_process";
import { limitReleaseBody } from "./release-body.mjs";

function repository() {
  const repo = process.env.GITHUB_REPOSITORY;

  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("GITHUB_REPOSITORY is required");

  return repo;
}

/** Only API diagnostics are exposed, never the request body, child environment or raw error object. */
export function githubRequest(args, body, run = execFileSync) {
  try {
    const output = run("gh", args, {
      encoding: "utf8",
      input: body === undefined ? undefined : JSON.stringify(body),
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, GH_TOKEN: process.env.GH_TOKEN || process.env.GITHUB_TOKEN },
    });

    return output ? JSON.parse(output) : undefined;
  } catch (error) {
    let detail = "GitHub request failed";

    try {
      const response = JSON.parse(String(error.stdout));
      detail = [
        response.message,
        ...(response.errors ?? []).map(({ resource, field, code, message }) =>
          [resource, field, code, message].filter(Boolean).join(": "),
        ),
      ]
        .filter(Boolean)
        .join("; ");
    } catch {
      // gh's transport/status diagnostic is useful even without a JSON API response.
      detail = String(error.stderr || detail);
    }

    for (const [key, value] of Object.entries(process.env)) {
      if (/token|secret|password|key/i.test(key) && value) detail = detail.replaceAll(value, "[REDACTED]");
    }

    throw new Error(detail.slice(0, 2_000));
  }
}

export function findGithubRelease(tag) {
  const pages = githubRequest(["api", "--paginate", "--slurp", `repos/${repository()}/releases?per_page=100`]);

  if (!Array.isArray(pages) || !pages.every(Array.isArray)) throw new Error("Invalid GitHub releases response");

  return pages.flat().find((release) => release.tag_name === tag);
}

export function githubDraft(body, repo = repository()) {
  githubRequest(["api", `repos/${repo}/releases`, "--method", "POST", "--input", "-"], {
    ...body,
    body: limitReleaseBody(body.body, `https://github.com/${repo}/compare/${body.tag_name}^...${body.tag_name}`),
  });
}

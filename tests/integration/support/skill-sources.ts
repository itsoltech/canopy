import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { skillFiles } from "./agent-skills.ts";

/** Real commits and bare remotes; git cannot consult the maintainer's home/config or run hooks. */
export function sourceRepository(root: string, name: string) {
  const work = join(root, name);
  const bare = join(root, `${name}.git`);
  mkdirSync(work, { recursive: true });

  const git = (...argv: string[]) => {
    const result = Bun.spawnSync(["git", "-c", "core.hooksPath=/dev/null", ...argv], {
      cwd: work,
      env: {
        PATH: process.env["PATH"],
        HOME: root,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_AUTHOR_NAME: "Fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.invalid",
        GIT_COMMITTER_NAME: "Fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      },
    });

    if (result.exitCode !== 0) throw new Error(`Fixture git failed: ${argv[0]}`);

    return result.stdout.toString().trim();
  };

  git("init", "--initial-branch=main");
  git("init", "--bare", "--initial-branch=main", bare);
  git("-C", bare, "config", "uploadpack.allowReachableSHA1InWant", "true");
  git("remote", "add", "origin", bare);

  const file = (path: string, content: Uint8Array | string) => {
    mkdirSync(dirname(join(work, path)), { recursive: true });
    writeFileSync(join(work, path), content);
  };

  const skill = (path: string, skillName: string, content = "Review safely.") => {
    for (const entry of skillFiles(skillName, content)) {
      file(`${path}/${entry.path}`, entry.content);

      if (entry.executable) chmodSync(join(work, path, entry.path), 0o755);
    }
  };

  const commit = () => {
    git("add", ".");
    git("commit", "-m", "fixture");
    git("push", "origin", "HEAD:main");

    return git("rev-parse", "HEAD");
  };

  return { work, bare, git, file, skill, commit };
}

/** Local smart HTTP backed by the same bare fixture. Auth is observed only as a boolean. */
export function sourceGitHttp(root: string) {
  let expected = "";
  let authenticated = false;

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      authenticated ||= Boolean(expected && request.headers.get("authorization") === expected);
      const url = new URL(request.url);

      const child = Bun.spawn(["git", "http-backend"], {
        env: {
          PATH: process.env["PATH"],
          HOME: root,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_PROJECT_ROOT: root,
          GIT_HTTP_EXPORT_ALL: "1",
          PATH_INFO: url.pathname,
          QUERY_STRING: url.search.slice(1),
          REQUEST_METHOD: request.method,
          CONTENT_TYPE: request.headers.get("content-type") ?? "",
          REMOTE_USER: "fixture",
        },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "ignore",
      });

      child.stdin.write(new Uint8Array(await request.arrayBuffer()));
      child.stdin.end();
      const data = Buffer.from(await new Response(child.stdout).arrayBuffer());
      await child.exited;
      const split = data.indexOf("\r\n\r\n");

      if (split < 0) return new Response("Fixture backend failed", { status: 500 });
      const headers = new Headers();
      let status = 200;

      for (const line of data.subarray(0, split).toString().split("\r\n")) {
        const colon = line.indexOf(":");
        const name = line.slice(0, colon);
        const value = line.slice(colon + 1).trim();

        if (name.toLowerCase() === "status") status = Number(value.split(" ")[0]);
        else headers.set(name, value);
      }

      return new Response(data.subarray(split + 4), { headers, status });
    },
  });

  return {
    url: server.url.origin,
    expect: (header: string) => {
      expected = header;
      authenticated = false;
    },
    authenticated: () => authenticated,
    stop: () => server.stop(true),
  };
}

export function skillRegistry() {
  let requests = 0;
  let hostile = false;

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      requests++;

      if (request.headers.has("authorization")) throw new Error("Registry received credentials.");
      const url = new URL(request.url);

      if (url.pathname !== "/api/search" || !url.searchParams.get("q"))
        return new Response("Not found", { status: 404 });

      return Response.json({
        skills: [{ name: "review", source: hostile ? "attacker/repo" : "fixture/collection", installs: 1 }],
      });
    },
  });

  return {
    url: server.url.origin,
    requests: () => requests,
    hostile: (value: boolean) => {
      hostile = value;
    },
    stop: () => server.stop(true),
  };
}

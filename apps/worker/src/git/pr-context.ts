import { create } from "@bufbuild/protobuf";
import { GitPrContextSchema, type ReadGitPrContext } from "@canopy/contracts";
import { normalizeGitOrigin } from "@canopy/domain/projects";
import { processKey, runProcess, withProcessPriority } from "@canopy/process-governor";

const oid = (value: string) => /^[0-9a-f]{40,64}$/.test(value);

/** One bounded, read-only checkout snapshot. Raw config never leaves this process. */
export class GitPrReader {
  async read(request: ReadGitPrContext) {
    return withProcessPriority("background", async () => {
      const signal = AbortSignal.timeout(2_000);

      const line = async (args: string[]) => {
        const command = {
          argv: ["git", ...args],
          cwd: request.repoPath,
          env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
          timeoutMs: 2_000,
          signal,
        };

        const result = await runProcess(command, {
          kind: "git",
          ...(!request.fresh && { key: processKey(command), ttlMs: 30_000 }),
        });

        return result.code === 0 ? result.stdout.trimEnd() : "";
      };

      const [head, branch, config] = await Promise.all([
        line(["rev-parse", "--verify", "HEAD"]),
        line(["symbolic-ref", "--quiet", "--short", "HEAD"]),
        line(["config", "--null", "--list"]),
      ]);

      const context = create(GitPrContextSchema, { headOid: oid(head) ? head : "", branch });

      if (!context.headOid) return context;
      const values = new Map<string, string[]>();

      for (const entry of config.split("\0")) {
        const index = entry.indexOf("\n");

        if (index < 0) continue;
        const key = entry.slice(0, index);
        values.set(key, [...(values.get(key) ?? []), entry.slice(index + 1)]);
      }

      const get = (key: string) => values.get(key)?.at(-1) ?? "";
      const names = [...new Set([...values.keys()].flatMap((k) => /^remote\.(.+)\.url$/.exec(k)?.[1] ?? []))];
      context.ambiguous = names.length > 8;
      context.remotes = names.slice(0, 8).map((name) => {
        const identities = (key: string) => [...new Set((values.get(key) ?? []).map(normalizeGitOrigin))];
        const fetch = identities(`remote.${name}.url`);
        const push = values.has(`remote.${name}.pushurl`) ? identities(`remote.${name}.pushurl`) : fetch;

        return { $typeName: "canopy.worker.v1.GitPrRemote", name, fetchRepositories: fetch, pushRepositories: push };
      });
      context.upstreamRemote = get(`branch.${branch}.remote`);
      context.upstreamRef = get(`branch.${branch}.merge`).replace(/^refs\/heads\//, "");
      context.pushRemote =
        get(`branch.${branch}.pushremote`) || get("remote.pushdefault") || context.upstreamRemote || "origin";
      const specs = values.get(`remote.${context.pushRemote}.push`) ?? [];

      if (branch) {
        const targets = specs.flatMap((spec) => {
          const [source, target] = spec.replace(/^\+/, "").split(":");

          if (source !== branch && source !== `refs/heads/${branch}` && source !== "HEAD") return [];

          return target?.startsWith("refs/heads/") ? [target.slice(11)] : [];
        });

        const mode = get("push.default") || "simple";
        context.pushRef = specs.length
          ? targets.length === 1 && specs.length === 1
            ? targets[0]!
            : ""
          : mode === "current" || (context.pushRemote !== context.upstreamRemote && mode === "simple")
            ? branch
            : mode === "upstream"
              ? context.upstreamRef
              : mode === "simple" && (!context.upstreamRef || context.upstreamRef === branch)
                ? branch
                : "";
        context.ambiguous ||= !context.pushRef || (values.get(`branch.${branch}.merge`)?.length ?? 0) > 1;
      }

      if (request.expectedHead && request.expectedHead !== head) return create(GitPrContextSchema);

      for (const ancestor of [...new Set(request.ancestorOids)].slice(0, 10)) {
        if (!oid(ancestor)) continue;

        // --is-ancestor returns no output; obtain its exit status directly through the governor.
        const result = await runProcess(
          {
            argv: ["git", "merge-base", "--is-ancestor", ancestor, head],
            cwd: request.repoPath,
            env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
            timeoutMs: 2_000,
            signal,
          },
          { kind: "git" },
        );

        if (result.code === 0) context.ancestorOids.push(ancestor);
      }

      return context;
    });
  }
}

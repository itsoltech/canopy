import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import type { ToolCall } from "@canopy/acp";
import { checkSkillPath, skillName } from "@canopy/domain/skill-artifact";
import { Option, Schema } from "effect";
import { isWithin } from "../../git/worktrees.ts";

const file = Schema.Struct({ Path: Schema.String });

const read = Schema.decodeUnknownOption(
  Schema.Struct({
    kind: Schema.Literal("read"),
    name: Schema.Literal("read_file"),
    args: Schema.optionalKey(file),
    rawInput: file,
    locations: Schema.Array(Schema.Struct({ path: Schema.String })),
  }),
);

/** agy asks to read a managed skill because its real path is outside the workspace. Only accept regular
 * files in this launch's skill bundles, with matching native arguments and permission locations. */
export function antigravitySkillRead(root: string | undefined, mount: string, tool: ToolCall): boolean {
  if (!root) return false;
  const operation = Option.getOrUndefined(read(tool));

  if (!operation || !operation.locations.length) return false;
  const input = operation.rawInput.Path;

  if (operation.args && operation.args.Path !== input) return false;

  if (!isAbsolute(input) || input.split(/[\\/]/).includes("..")) return false;
  const source = [mount, root].find((dir) => isWithin(dir, input));

  if (!source) return false;
  const [name, ...rest] = relative(source, input).split(sep);

  if (!name || !skillName(name)) return false;

  try {
    checkSkillPath(rest.join("/"));
    const target = join(root, name, ...rest);

    // Reject nested aliases even if they currently resolve inside the registered skills directory.
    if (relative(target, realpathSync(input)) || !lstatSync(target).isFile()) return false;

    if (!lstatSync(join(root, name, "SKILL.md")).isFile()) return false;

    return operation.locations.every(({ path }) => isAbsolute(path) && !relative(target, path));
  } catch {
    return false;
  }
}

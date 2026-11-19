export function checkSkillPath(path: string): void {
  if (
    !path ||
    path.length > 240 ||
    path.includes("\\") ||
    path
      .split("/")
      .some(
        (part) =>
          !/^[a-zA-Z0-9_. -]+$/.test(part) ||
          part === "." ||
          part === ".." ||
          /[. ]$/.test(part) ||
          /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part),
      )
  )
    throw new Error("Skill paths must be relative, portable paths without traversal or reserved names.");
}

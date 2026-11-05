import { describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { expandProjectIds, normalizeGitOrigin, projectChoices } from "./projects.ts";

describe("linked project identity", () => {
  test("normalizes Git transports, host case, credentials and suffixes without changing path case", () => {
    for (const remote of [
      "git@GitHub.com:itsoltech/pinpoint.git",
      "ssh://git@GITHUB.com/itsoltech/pinpoint.git/",
      "https://github.com/itsoltech/pinpoint/",
      "https://user:fixture-secret@github.com/itsoltech/pinpoint.git",
      "ssh://git@github.com:22/itsoltech/pinpoint",
    ])
      expect(normalizeGitOrigin(remote)).toBe("github.com/itsoltech/pinpoint");
    expect(normalizeGitOrigin("ssh://git@example.com:2222/Owner/Repo.git")).toBe("example.com:2222/Owner/Repo");

    for (const remote of [
      "",
      "/local/repo.git",
      "../repo",
      "C:/repo.git",
      "file:///repo",
      "https://host/repo?token=fixture",
    ])
      expect(normalizeGitOrigin(remote)).toBe("");
  });

  const project = (id: string, name: string, nodeId: string, origin: string, kind = "project") =>
    create(ui.ProjectSchema, {
      id,
      name,
      nodeId,
      kind,
      workspaces: [{ id: `${id}-workspace`, projectId: id, workerId: `${nodeId}-worker`, gitOrigin: origin }],
    });

  const origin = "github.com/itsoltech/pinpoint";

  test("prefers the local name, preserves aliases and routes with the original workspace project", () => {
    const choices = projectChoices([
      project("b", "Other name", "b-home", origin),
      project("a", "Pinpoint", "", origin),
    ]);

    expect(choices).toHaveLength(1);
    expect(choices[0]?.name).toBe("Pinpoint");
    expect(choices[0]?.aliases).toEqual(["Other name"]);
    expect(choices[0]?.workspaces.map((workspace) => workspace.projectId)).toEqual(["a", "b"]);
    expect(expandProjectIds(["b"], choices)).toEqual(["a", "b"]);
  });

  test("keeps absent, conflicting and ambiguous same-gateway origins separate", () => {
    expect(projectChoices([project("a", "Same", "", ""), project("b", "Same", "b-home", "")])).toHaveLength(2);
    expect(
      projectChoices([project("a", "Same", "", origin), project("b", "Same", "b-home", `${origin}-other`)]),
    ).toHaveLength(2);
    expect(
      projectChoices([
        project("a", "One", "", origin),
        project("b", "Two", "", origin),
        project("c", "Remote", "c-home", origin),
      ]),
    ).toHaveLength(3);
    const mixed = project("a", "Mixed", "", origin);
    mixed.workspaces.push(create(ui.WorkspaceSchema, { gitOrigin: "other.example/team/project" }));
    expect(projectChoices([mixed, project("b", "Remote", "b-home", origin)])).toHaveLength(2);
    mixed.workspaces[1]!.gitOrigin = "";
    expect(projectChoices([mixed, project("b", "Remote", "b-home", origin)])).toHaveLength(2);
  });

  test("offers one No project with every computer's original scratch workspace", () => {
    const choices = projectChoices([
      project("a", "No project", "", "", "scratch"),
      project("b", "No project", "b-home", "", "scratch"),
    ]);

    expect(choices).toHaveLength(1);
    expect(choices[0]?.workspaces.map((workspace) => workspace.projectId)).toEqual(["a", "b"]);
  });
});

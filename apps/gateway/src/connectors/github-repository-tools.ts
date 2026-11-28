import { create } from "@bufbuild/protobuf";
import { ConnectorToolSchema } from "@canopy/contracts";
import type { JsonObject } from "@canopy/domain";
import { Option, Schema } from "effect";
import type { AccountRow } from "./records.ts";

export class GitHubToolFailure extends Error {}

const integer = (max: number) => Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(max));
const number = integer(2_147_483_647);
const title = Schema.String.check(Schema.isPattern(/\S/), Schema.isMaxLength(256));
const body = Schema.String.check(Schema.isPattern(/\S/), Schema.isMaxLength(32_000));

const ref = Schema.String.check(
  Schema.isMaxLength(255),
  Schema.isPattern(/^(?![-/])(?!.*\.\.)(?!.*(?:^|\/)\.)(?!.*\/\/)(?!.*\.lock(?:\/|$))[\w./-]+(?<![./])$/),
);

const path = Schema.NonEmptyString.check(Schema.isMaxLength(2048));

const List = Schema.Struct({
  state: Schema.optionalKey(Schema.Literals(["open", "closed", "all"])),
  page: Schema.optionalKey(integer(10000)),
  per_page: Schema.optionalKey(integer(30)),
});

const ByNumber = Schema.Struct({ number });

interface Request {
  path: string;
  body?: JsonObject;
  project: "file" | "issues" | "issue" | "pulls" | "pull" | "comment";
  number?: number;
  offset?: number;
  page?: number;
  perPage?: number;
}

function list(resource: "issues" | "pulls", args: typeof List.Type): Request {
  const { page = 1, per_page: perPage = 15, state = "open" } = args;

  return { path: `/${resource}?state=${state}&page=${page}&per_page=${perPage}`, project: resource, page, perPage };
}

function operation<S extends Schema.Top>(
  remoteName: string,
  description: string,
  readOnly: boolean,
  input: S & { readonly DecodingServices: never },
  prepare: (args: S["Type"]) => Request,
) {
  const options = { onExcessProperty: "error" } as const;
  const inputSchemaJson = JSON.stringify(Schema.toJsonSchemaDocument(input, options).schema);
  const parse = Schema.decodeUnknownOption(input, options);

  return {
    remoteName,
    description,
    readOnly,
    inputSchemaJson,
    request: (args: JsonObject) => {
      const decoded = parse(args);

      if (Option.isNone(decoded)) throw new GitHubToolFailure("Check the arguments against the GitHub tool schema.");

      return prepare(decoded.value);
    },
  };
}

const operations = [
  operation(
    "read_file",
    "Read a UTF-8 text file by its repository-relative path. Optionally select a branch, tag or commit. Pass nextOffset as offset to continue long files.",
    true,
    Schema.Struct({
      path,
      ref: Schema.optionalKey(ref),
      offset: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1_048_576 }))),
    }),
    (args) => {
      const parts = args.path.split("/");

      if (parts.some((p) => !p || p === "." || p === ".." || /[\\%\p{Cc}]/u.test(p)))
        throw new GitHubToolFailure("Use a repository-relative file path with no empty or traversal segments.");

      const query = args.ref ? `?ref=${encodeURIComponent(args.ref)}` : "";

      return {
        path: `/contents/${parts.map(encodeURIComponent).join("/")}${query}`,
        project: "file",
        offset: args.offset ?? 0,
      };
    },
  ),
  operation("list_issues", "List issues by state and page.", true, List, (args) => list("issues", args)),
  operation("read_issue", "Read an issue by number.", true, ByNumber, (args) => ({
    path: `/issues/${args.number}`,
    project: "issue",
  })),
  operation("list_pull_requests", "List pull requests by state and page.", true, List, (args) => list("pulls", args)),
  operation("read_pull_request", "Read a pull request by number.", true, ByNumber, (args) => ({
    path: `/pulls/${args.number}`,
    project: "pull",
  })),
  operation(
    "create_issue",
    "Create an issue in this repository.",
    false,
    Schema.Struct({ title, body: Schema.optionalKey(body) }),
    (args) => ({ path: "/issues", body: { ...args }, project: "issue" }),
  ),
  operation(
    "add_comment",
    "Comment on an issue or pull request by number.",
    false,
    Schema.Struct({ number, body }),
    (args) => ({
      path: `/issues/${args.number}/comments`,
      number: args.number,
      body: { body: args.body },
      project: "comment",
    }),
  ),
  operation(
    "create_pull_request",
    "Open a pull request between two existing branches of this repository. Use unqualified branch names.",
    false,
    Schema.Struct({
      head: ref,
      base: ref,
      title,
      body: Schema.optionalKey(body),
      draft: Schema.optionalKey(Schema.Boolean),
    }),
    (args) => ({ path: "/pulls", body: { ...args }, project: "pull" }),
  ),
];

export function githubRepositoryTools(row: Pick<AccountRow, "id" | "name" | "namespace" | "github_allow_writes">) {
  return operations.flatMap(({ remoteName, description, readOnly, inputSchemaJson }) => {
    if (!readOnly && !row.github_allow_writes) return [];

    return [
      create(ConnectorToolSchema, {
        accountId: row.id,
        accountName: row.name,
        connectorType: "github_repository",
        name: `${row.namespace.slice(0, 39)}__${remoteName}`,
        remoteName,
        description: `GitHub · ${row.name}: ${description}`,
        readOnly,
        inputSchemaJson,
      }),
    ];
  });
}

export function githubRepositoryRequest(remoteName: string, args: JsonObject) {
  const operation = operations.find((item) => item.remoteName === remoteName);

  if (!operation) throw new GitHubToolFailure("This GitHub tool is unavailable.");

  return operation.request(args);
}

export type GitHubRepositoryRequest = Request;

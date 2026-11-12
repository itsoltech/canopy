import { create } from "@bufbuild/protobuf";
import { github } from "@canopy/contracts";
import { Schema } from "effect";
import { digest, readScope } from "./read-scope.ts";
import type { GitHubPullRequests } from "./pull-requests.ts";
import { avatarUrl } from "./avatar-url.ts";
import { Code, ConnectError } from "@connectrpc/connect";
import { uuid } from "./records.ts";

export async function pullRequestAvatar(prs: GitHubPullRequests, request: github.PullRequestAvatarRequest) {
  let accountId: string;
  let source = request.pullRequestId ? avatarUrl(request.url) : "";

  if (request.pullRequestId) {
    const scope = await readScope(
      prs,
      create(github.PullRequestPageRequestSchema, { pullRequestId: request.pullRequestId }),
      "avatar",
    );

    accountId = scope.row.id;
  } else {
    if (!uuid(request.accountId)) throw new ConnectError("Choose a GitHub account", Code.InvalidArgument);
    await prs.accounts.access.token(request.accountId);
    accountId = request.accountId;
    const user = await prs.client.read(accountId, { key: "avatar:self", path: "/user", ttl: 86_400_000 });
    source = Schema.decodeUnknownSync(Schema.Struct({ avatar_url: Schema.String }))(user.payload).avatar_url;
  }

  const url = avatarUrl(source);

  const cached = await prs.client.read(accountId, {
    key: `avatar:${digest(url)}`,
    path: url,
    image: true,
    ttl: 86_400_000,
  });

  return create(
    github.PullRequestAvatarSchema,
    Schema.decodeUnknownSync(Schema.Struct({ dataUrl: Schema.String }))(cached.payload),
  );
}

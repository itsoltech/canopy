import type { GitHubOptions } from "../../../apps/gateway/src/github/http.ts";

function catalogueResponse(url: URL, user: number, count: number, long: boolean, echo = "") {
  const page = Number(url.searchParams.get("page") || 1);

  const login =
    (long ? `organization-${user}-with-a-very-long-name-for-repository-access` : `organization-${user}`) + echo;

  if (url.pathname === "/user/installations")
    return Response.json({
      total_count: count,
      installations: Array.from({ length: Math.max(0, Math.min(100, count - (page - 1) * 100)) }, (_, n) => ({
        id: user + ((page - 1) * 100 + n) * 1000,
        account: { login: `${login}${n ? `-${n}` : ""}`, type: "Organization" },
        repository_selection: "selected",
        permissions: { contents: "write", pull_requests: "write" },
        suspended_at: null,
      })),
    });

  if (/^\/user\/installations\/[0-9]+\/repositories$/.test(url.pathname))
    return Response.json({
      total_count: count,
      repositories: Array.from({ length: Math.max(0, Math.min(100, count - (page - 1) * 100)) }, (_, n) => ({
        id: user * 10 + (page - 1) * 100 + n,
        full_name: `${login}/${long ? "a-repository-with-a-long-name-and-extra-descriptive-details" : "canopy"}${n ? `-${n}` : ""}`,
        private: true,
        permissions: { pull: true, push: true },
      })),
    });

  return Response.json({}, { status: 404 });
}

/** All requests use loopback HTTP. An unexpected endpoint fails instead of reaching GitHub. */
export function githubFixture() {
  let now = Date.now();
  let sequence = 0;
  let refreshes = 0;
  let polls = 0;
  let nextUser = 101;
  let mode = "authorization_pending";
  let apiStatus = 200;
  let refreshStatus = 200;
  let refreshGate: Promise<void> = Promise.resolve();
  let deviceGate: Promise<void> = Promise.resolve();
  let catalogueCount = 1;
  let longNames = false;
  let echoSecrets = false;
  const codes = new Map<string, number>();
  const tokens = new Map<string, number>();
  const refreshTokens = new Map<string, number>();
  const secrets: string[] = [];

  const pair = (user: number) => {
    const access = `ghu_fixture_${++sequence}`;
    const refresh = `ghr_fixture_${++sequence}`;
    tokens.set(access, user);
    refreshTokens.set(refresh, user);
    secrets.push(access, refresh);

    return {
      access_token: access,
      refresh_token: refresh,
      token_type: "bearer",
      expires_in: 28_800,
      refresh_token_expires_in: 15_552_000,
    };
  };

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);

      if (url.pathname === "/login/device/code") {
        const code = `device_fixture_${++sequence}`;
        secrets.push(code);
        codes.set(code, nextUser);

        return Response.json({
          device_code: code,
          user_code: "ABCD-EFGH",
          verification_uri: "https://github.com/login/device",
          expires_in: 900,
          interval: 5,
        });
      }

      if (url.pathname === "/login/oauth/access_token") {
        const form = new URLSearchParams(await request.text());

        if (form.get("grant_type") === "refresh_token") {
          refreshes++;
          const token = form.get("refresh_token") ?? "";
          const user = refreshTokens.get(token);
          refreshTokens.delete(token);
          await refreshGate;

          if (!user || refreshStatus !== 200)
            return Response.json({ error: "bad_refresh_token" }, { status: refreshStatus });

          return Response.json(pair(user));
        }

        polls++;
        await deviceGate;
        const code = form.get("device_code") ?? "";

        if (!codes.has(code)) return Response.json({ error: "expired_token" });

        if (mode !== "success") return Response.json({ error: mode });
        const user = codes.get(code)!;
        codes.delete(code);

        return Response.json(pair(user));
      }

      const access = request.headers.get("authorization")?.replace("Bearer ", "") ?? "";
      const user = tokens.get(access);

      if (!user || apiStatus !== 200)
        return Response.json({ error: "unauthorized" }, { status: apiStatus === 200 ? 401 : apiStatus });

      if (url.pathname === "/user")
        return Response.json({
          id: user,
          login:
            (longNames ? `account-${user}-with-a-very-long-company-name` : `account-${user}`) +
            (echoSecrets ? `-${access}-${secrets.at(-1)}` : ""),
        });

      return catalogueResponse(url, user, catalogueCount, longNames, echoSecrets ? `-${access}-${secrets.at(-1)}` : "");
    },
  });

  const fixtureFetch: typeof fetch = Object.assign(
    (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL(String(input));

      if (!["https://github.com", "https://api.github.com"].includes(url.origin))
        throw new Error("Unexpected GitHub origin");

      return fetch(new URL(`${url.pathname}${url.search}`, server.url), init);
    },
    { preconnect: fetch.preconnect },
  );

  const options: GitHubOptions = {
    clientId: "fixture-client",
    slug: "canopy-fixture",
    fetch: fixtureFetch,
    now: () => now,
  };

  return {
    options,
    secrets,
    echo: (value: boolean) => {
      echoSecrets = value;
    },
    pat: (user: number) => pair(user).access_token,
    catalogue: (count: number, long = false) => {
      catalogueCount = count;
      longNames = long;
    },
    deviceGate: (value: Promise<void>) => {
      deviceGate = value;
    },
    advance: (ms: number) => {
      now += ms;
    },
    user: (id: number) => {
      nextUser = id;
    },
    mode: (value: string) => {
      mode = value;
    },
    apiStatus: (value: number) => {
      apiStatus = value;
    },
    refreshStatus: (value: number) => {
      refreshStatus = value;
    },
    gate: (value: Promise<void>) => {
      refreshGate = value;
    },
    get refreshes() {
      return refreshes;
    },
    get polls() {
      return polls;
    },
    close: () => server.stop(true),
  };
}

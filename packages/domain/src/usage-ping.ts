export const usagePingEndpoint = "https://analytics.itsol.tech/api/send";
export const usagePingTimeoutMs = 10_000;
export const usagePingRetryMs = 15 * 60 * 1000;

interface UsagePingDetails {
  version: string;
  os: string;
  arch?: string;
  language: string;
  screen: string;
}

export function usagePingBody({ version, os, arch, language, screen }: UsagePingDetails) {
  return JSON.stringify({
    type: "event",
    payload: {
      website: "e2ef58e3-bbc0-490c-9afb-263cbfce1640",
      hostname: "app.canopy.itsol.tech",
      url: "/ping",
      language,
      screen,
      data: { version, os, arch },
    },
  });
}

export const CLIENT_SOURCES = ["web", "desktop", "mobile", "bff"] as const;

export type ClientSource = (typeof CLIENT_SOURCES)[number];

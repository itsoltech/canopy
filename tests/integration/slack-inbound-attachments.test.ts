import { expect, test } from "bun:test";
import { Provider } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { eventually } from "./support/gateway.ts";
import { harnessBots } from "./support/harness-bots.ts";
import { slackMessengerFixture } from "./support/slack-messenger.ts";

test.skipIf(!dockerAvailable)(
  "Socket Mode delivers admitted Slack attachments through the worker and preserves text when files are unavailable",
  async () => {
    const slack = slackMessengerFixture();
    const lookedUp: string[] = [];
    const bytes = "Fixture content read from the Slack attachment";
    let clockOffset = 0;

    const f = await harnessBots({
      attachmentLimits: { maxFileBytes: 128, maxMessageBytes: 256, maxFiles: 5 },
      botClock: () => new Date(Date.now() + clockOffset),
      messengerTransport: {
        ...slack.transport,
        fetch: async (input, init) => {
          const request = new Request(input, init);
          const url = new URL(request.url);

          if (url.pathname === "/api/files.info") {
            expect(request.headers.get("authorization")).toBe("Bearer xoxb-fixture");
            const id = url.searchParams.get("file") ?? "";
            lookedUp.push(id);

            if (id === "FMISSING") return Response.json({ ok: false, error: "file_not_found" });

            return Response.json({
              ok: true,
              file: {
                id,
                name: "report.txt",
                size: id === "FLARGE" ? 2048 : bytes.length,
                url_private: "https://files.slack.com/files-pri/fixture/report.txt",
              },
            });
          }

          if (url.origin === "https://files.slack.com") {
            expect(request.headers.get("authorization")).toBe("Bearer xoxb-fixture");

            return new Response(bytes);
          }

          return fetch(request);
        },
      },
    });

    try {
      const bot = await f.add(Provider.CODEX);

      const account = (
        await f.gw.api.saveMessengerAccount({
          name: "Fixture Slack",
          appToken: "xapp-fixture",
          botToken: "xoxb-fixture",
        })
      ).account!;

      await f.gw.api.saveBotMessengerRoute({
        route: {
          botId: bot.id,
          accountId: account.id,
          channelIds: ["CGENERAL"],
          userIds: ["UOWNER"],
          mentions: true,
          delivery: "reply",
        },
      });

      f.gw.core.messengers.start();
      await eventually(
        () => f.gw.api.listMessengerAccounts({}),
        (r) => r.accounts.some((a) => a.status === "connected"),
      );

      slack.emit("attachments", "<@UAPP> Summarize the Slack report", "100.1", "100.1", [
        { id: "FREPORT", url_private: "https://invalid.example/untrusted-event-field" },
        { id: "FREPORT" },
        { id: "FMISSING" },
        { id: "FLARGE" },
      ]);

      expect(await eventually(async () => slack.acknowledged.has("attachments"), Boolean)).toBe(true);
      expect(lookedUp).toEqual([]);
      clockOffset += 4000;
      await f.gw.core.messengers.tick();
      expect(
        await eventually(
          async () => slack.sent.length,
          (n) => n === 1,
        ),
      ).toBe(1);

      const prompt = f
        .inputs()
        .at(-1)
        ?.parts.map((part) => part.text)
        .join("\n");

      expect(lookedUp).toEqual(["FREPORT", "FMISSING", "FLARGE"]);
      expect(prompt).toContain("Summarize the Slack report");
      expect(prompt).toContain(bytes);
      expect(prompt).toContain("Some Slack attachments were unavailable.");
      expect(prompt).not.toContain("untrusted-event-field");
      expect(await f.query("SELECT slack_file_id, name FROM attachments WHERE bot_id=$1", [bot.id])).toEqual([
        { slack_file_id: "FREPORT", name: "report.txt" },
      ]);

      await f.gw.api.updateBot({ botId: bot.id, configuration: { ...bot.configuration!, files: false } });
      slack.emit("files-disabled", "Files are disabled for this turn", "100.2", "100.1", [{ id: "FDISABLED" }]);
      expect(await eventually(async () => slack.acknowledged.has("files-disabled"), Boolean)).toBe(true);
      clockOffset += 4000;
      await f.gw.core.messengers.tick();
      expect(
        await eventually(
          async () => slack.sent.length,
          (n) => n === 2,
        ),
      ).toBe(2);

      const disabled = f
        .inputs()
        .at(-1)
        ?.parts.map((part) => part.text)
        .join("\n");

      expect(disabled).toContain("Files are disabled for this turn");
      expect(disabled).toContain("Some Slack attachments were unavailable.");
      expect(lookedUp).toEqual(["FREPORT", "FMISSING", "FLARGE"]);
    } finally {
      await f.close();
      await slack.close();
    }
  },
  60_000,
);

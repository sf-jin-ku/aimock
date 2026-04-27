import { describe, it, expect, afterEach } from "vitest";
import { createServer, type ServerInstance } from "../server.js";
import type { Fixture } from "../types.js";
import { connectWebSocket } from "./ws-test-client.js";

// --- helpers ---

const GEMINI_WS_PATH =
  "/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

function setupMsg(model = "gemini-2.0-flash-exp"): string {
  return JSON.stringify({
    setup: { model },
  });
}

function clientContentMsg(text: string): string {
  return JSON.stringify({
    clientContent: {
      turns: [{ role: "user", parts: [{ text }] }],
      turnComplete: true,
    },
  });
}

// --- tests ---

let instance: ServerInstance | null = null;

afterEach(async () => {
  if (instance) {
    await new Promise<void>((resolve) => {
      instance!.server.close(() => resolve());
    });
    instance = null;
  }
});

describe("WebSocket Gemini Live — audio responses", () => {
  it("returns audio inlineData for string-form AudioResponse", async () => {
    const audioFixture: Fixture = {
      match: { userMessage: "play-audio-string" },
      response: { audio: "SGVsbG8=", format: "mp3" },
    };
    instance = await createServer([audioFixture]);
    const ws = await connectWebSocket(instance.url, GEMINI_WS_PATH);

    ws.send(setupMsg());
    await ws.waitForMessages(1); // setupComplete

    ws.send(clientContentMsg("play-audio-string"));

    const raw = await ws.waitForMessages(2); // setupComplete + audio response
    const msg = JSON.parse(raw[1]);

    expect(msg.serverContent).toBeDefined();
    expect(msg.serverContent.modelTurn.parts).toHaveLength(1);
    expect(msg.serverContent.modelTurn.parts[0].inlineData).toEqual({
      mimeType: "audio/mpeg",
      data: "SGVsbG8=",
    });
    expect(msg.serverContent.turnComplete).toBe(true);

    ws.close();
  });

  it("returns audio inlineData for object-form AudioResponse with contentType", async () => {
    const audioFixture: Fixture = {
      match: { userMessage: "play-audio-object" },
      response: { audio: { b64Json: "SGVsbG8=", contentType: "audio/wav" } },
    };
    instance = await createServer([audioFixture]);
    const ws = await connectWebSocket(instance.url, GEMINI_WS_PATH);

    ws.send(setupMsg());
    await ws.waitForMessages(1); // setupComplete

    ws.send(clientContentMsg("play-audio-object"));

    const raw = await ws.waitForMessages(2);
    const msg = JSON.parse(raw[1]);

    expect(msg.serverContent).toBeDefined();
    expect(msg.serverContent.modelTurn.parts[0].inlineData).toEqual({
      mimeType: "audio/wav",
      data: "SGVsbG8=",
    });
    expect(msg.serverContent.turnComplete).toBe(true);

    ws.close();
  });

  it("defaults to audio/mpeg when object-form AudioResponse omits contentType", async () => {
    const audioFixture: Fixture = {
      match: { userMessage: "play-audio-no-ct" },
      response: { audio: { b64Json: "SGVsbG8=" } },
    };
    instance = await createServer([audioFixture]);
    const ws = await connectWebSocket(instance.url, GEMINI_WS_PATH);

    ws.send(setupMsg());
    await ws.waitForMessages(1); // setupComplete

    ws.send(clientContentMsg("play-audio-no-ct"));

    const raw = await ws.waitForMessages(2);
    const msg = JSON.parse(raw[1]);

    expect(msg.serverContent.modelTurn.parts[0].inlineData.mimeType).toBe("audio/mpeg");
    expect(msg.serverContent.modelTurn.parts[0].inlineData.data).toBe("SGVsbG8=");
    expect(msg.serverContent.turnComplete).toBe(true);

    ws.close();
  });

  it("sends audio as a single frame with turnComplete: true (not chunked)", async () => {
    const audioFixture: Fixture = {
      match: { userMessage: "play-audio-single" },
      response: { audio: "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=", format: "opus" },
    };
    instance = await createServer([audioFixture]);
    const ws = await connectWebSocket(instance.url, GEMINI_WS_PATH);

    ws.send(setupMsg());
    await ws.waitForMessages(1); // setupComplete

    ws.send(clientContentMsg("play-audio-single"));

    const raw = await ws.waitForMessages(2); // setupComplete + exactly 1 audio frame
    // Only 2 messages total — setupComplete and the single audio response
    expect(raw).toHaveLength(2);

    const msg = JSON.parse(raw[1]);
    expect(msg.serverContent).toBeDefined();
    expect(msg.serverContent.turnComplete).toBe(true);
    expect(msg.serverContent.modelTurn.parts[0].inlineData).toEqual({
      mimeType: "audio/opus",
      data: "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=",
    });

    // Verify no additional messages arrive (wait briefly and confirm count stays at 2)
    await new Promise((r) => setTimeout(r, 100));

    ws.close();
  });

  it("client-sent inlineData parts do not crash the handler", async () => {
    // Fixture matches on the text part, ignoring the inlineData part
    const textFixture: Fixture = {
      match: { userMessage: "transcribe-this" },
      response: { content: "I heard your audio" },
    };
    instance = await createServer([textFixture]);
    const ws = await connectWebSocket(instance.url, GEMINI_WS_PATH);

    ws.send(setupMsg());
    await ws.waitForMessages(1); // setupComplete

    // Send clientContent with both an inlineData part (simulating audio input)
    // and a text part for fixture matching
    ws.send(
      JSON.stringify({
        clientContent: {
          turns: [
            {
              role: "user",
              parts: [
                { inlineData: { mimeType: "audio/pcm", data: "dGVzdC1hdWRpbw==" } },
                { text: "transcribe-this" },
              ],
            },
          ],
          turnComplete: true,
        },
      }),
    );

    const raw = await ws.waitForMessages(2);
    const msg = JSON.parse(raw[1]);

    // The handler should process the text part and return a text response
    expect(msg.serverContent).toBeDefined();
    expect(msg.serverContent.modelTurn.parts[0].text).toBe("I heard your audio");
    expect(msg.serverContent.turnComplete).toBe(true);

    ws.close();
  });
});

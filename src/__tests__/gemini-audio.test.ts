import { describe, test, expect, afterEach } from "vitest";
import { LLMock } from "../llmock.js";

describe("Gemini audio responses", () => {
  let mock: LLMock;

  afterEach(async () => {
    await mock?.stop();
  });

  test("non-streaming generateContent with string-form audio", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "piano loop" },
      response: { audio: "SGVsbG8=", format: "mp3" },
    });
    await mock.start();

    const res = await fetch(`${mock.url}/v1beta/models/lyria-3:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "piano loop" }] }],
      }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.candidates[0].content.parts[0].inlineData).toEqual({
      mimeType: "audio/mpeg",
      data: "SGVsbG8=",
    });
    expect(data.candidates[0].finishReason).toBe("STOP");
    expect(data.usageMetadata).toBeDefined();
  });

  test("streaming streamGenerateContent with string-form audio", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "piano loop" },
      response: { audio: "SGVsbG8=", format: "mp3" },
    });
    await mock.start();

    const res = await fetch(`${mock.url}/v1beta/models/lyria-3:streamGenerateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "piano loop" }] }],
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");

    const text = await res.text();
    // Parse SSE data lines
    const chunks = text
      .split("\n\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.replace("data: ", "")));

    expect(chunks.length).toBeGreaterThanOrEqual(1);
    const chunk = chunks[0];
    expect(chunk.candidates[0].content.parts[0].inlineData).toEqual({
      mimeType: "audio/mpeg",
      data: "SGVsbG8=",
    });
    expect(chunk.candidates[0].finishReason).toBe("STOP");
  });

  test("non-streaming with object-form audio", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "wav audio" },
      response: { audio: { b64Json: "SGVsbG8=", contentType: "audio/wav" } },
    });
    await mock.start();

    const res = await fetch(`${mock.url}/v1beta/models/lyria-3:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "wav audio" }] }],
      }),
    });
    const data = await res.json();
    expect(data.candidates[0].content.parts[0].inlineData).toEqual({
      mimeType: "audio/wav",
      data: "SGVsbG8=",
    });
  });

  test("object-form audio without contentType defaults to audio/mpeg", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "default format" },
      response: { audio: { b64Json: "SGVsbG8=" } },
    });
    await mock.start();

    const res = await fetch(`${mock.url}/v1beta/models/lyria-3:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "default format" }] }],
      }),
    });
    const data = await res.json();
    expect(data.candidates[0].content.parts[0].inlineData.mimeType).toBe("audio/mpeg");
  });

  test("string-form audio with format opus", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "opus audio" },
      response: { audio: "SGVsbG8=", format: "opus" },
    });
    await mock.start();

    const res = await fetch(`${mock.url}/v1beta/models/lyria-3:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "opus audio" }] }],
      }),
    });
    const data = await res.json();
    expect(data.candidates[0].content.parts[0].inlineData.mimeType).toBe("audio/opus");
  });

  test("Vertex AI path works too", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "piano loop" },
      response: { audio: "SGVsbG8=", format: "mp3" },
    });
    await mock.start();

    const res = await fetch(
      `${mock.url}/v1/projects/proj/locations/us-central1/publishers/google/models/lyria-3:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "piano loop" }] }],
        }),
      },
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.candidates[0].content.parts[0].inlineData).toEqual({
      mimeType: "audio/mpeg",
      data: "SGVsbG8=",
    });
  });

  test("onAudio() convenience method works via Gemini", async () => {
    mock = new LLMock({ port: 0 });
    mock.onAudio("piano loop", { audio: "SGVsbG8=" });
    await mock.start();

    const res = await fetch(`${mock.url}/v1beta/models/lyria-3:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "piano loop" }] }],
      }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    // onAudio without format defaults to mp3
    expect(data.candidates[0].content.parts[0].inlineData).toEqual({
      mimeType: "audio/mpeg",
      data: "SGVsbG8=",
    });
  });
});

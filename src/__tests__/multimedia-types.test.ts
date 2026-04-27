import { describe, test, expect } from "vitest";
import {
  isImageResponse,
  isAudioResponse,
  isTranscriptionResponse,
  isVideoResponse,
} from "../helpers.js";
import { matchFixture } from "../router.js";
import type { Fixture, ChatCompletionRequest, FixtureResponse } from "../types.js";

describe("multimedia type guards", () => {
  test("isImageResponse detects single image", () => {
    const r: FixtureResponse = { image: { url: "https://example.com/img.png" } };
    expect(isImageResponse(r)).toBe(true);
  });

  test("isImageResponse detects multiple images", () => {
    const r: FixtureResponse = {
      images: [{ url: "https://example.com/1.png" }, { url: "https://example.com/2.png" }],
    };
    expect(isImageResponse(r)).toBe(true);
  });

  test("isImageResponse rejects text response", () => {
    const r: FixtureResponse = { content: "hello" };
    expect(isImageResponse(r)).toBe(false);
  });

  test("isAudioResponse detects audio (string form)", () => {
    const r: FixtureResponse = { audio: "AAAA", format: "mp3" };
    expect(isAudioResponse(r)).toBe(true);
  });

  test("isAudioResponse detects audio (object form with contentType)", () => {
    const r: FixtureResponse = { audio: { b64Json: "abc", contentType: "audio/mp3" } };
    expect(isAudioResponse(r)).toBe(true);
  });

  test("isAudioResponse detects audio (object form without contentType)", () => {
    const r: FixtureResponse = { audio: { b64Json: "abc" } };
    expect(isAudioResponse(r)).toBe(true);
  });

  test("isAudioResponse accepts empty b64Json (validation is in fixture-loader)", () => {
    const r: FixtureResponse = { audio: { b64Json: "" } };
    expect(isAudioResponse(r)).toBe(true);
  });

  test("isAudioResponse rejects numeric audio", () => {
    const r = { audio: 123 } as unknown as FixtureResponse;
    expect(isAudioResponse(r)).toBe(false);
  });

  test("isAudioResponse rejects object without b64Json", () => {
    const r = { audio: { foo: "bar" } } as unknown as FixtureResponse;
    expect(isAudioResponse(r)).toBe(false);
  });

  test("isAudioResponse rejects text response", () => {
    const r: FixtureResponse = { content: "hello" };
    expect(isAudioResponse(r)).toBe(false);
  });

  test("isTranscriptionResponse detects transcription", () => {
    const r: FixtureResponse = { transcription: { text: "hello" } };
    expect(isTranscriptionResponse(r)).toBe(true);
  });

  test("isTranscriptionResponse rejects text response", () => {
    const r: FixtureResponse = { content: "hello" };
    expect(isTranscriptionResponse(r)).toBe(false);
  });

  test("isVideoResponse detects video", () => {
    const r: FixtureResponse = {
      video: { id: "v1", status: "completed", url: "https://example.com/v.mp4" },
    };
    expect(isVideoResponse(r)).toBe(true);
  });

  test("isVideoResponse rejects text response", () => {
    const r: FixtureResponse = { content: "hello" };
    expect(isVideoResponse(r)).toBe(false);
  });
});

describe("endpoint filtering in matchFixture", () => {
  test("fixture with endpoint: image only matches image requests", () => {
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "guitar", endpoint: "image" },
        response: { image: { url: "img.png" } },
      },
    ];
    const chatReq: ChatCompletionRequest = {
      model: "gpt-4",
      messages: [{ role: "user", content: "guitar" }],
      _endpointType: "chat",
    };
    expect(matchFixture(fixtures, chatReq)).toBeNull();

    const imageReq: ChatCompletionRequest = {
      model: "dall-e-3",
      messages: [{ role: "user", content: "guitar" }],
      _endpointType: "image",
    };
    expect(matchFixture(fixtures, imageReq)).toBe(fixtures[0]);
  });

  test("fixture without endpoint matches chat/embedding requests but not multimedia", () => {
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "guitar" },
        response: { content: "Chat about guitars" },
      },
    ];
    // Chat requests match generic fixtures
    const chatReq: ChatCompletionRequest = {
      model: "gpt-4",
      messages: [{ role: "user", content: "guitar" }],
      _endpointType: "chat",
    };
    expect(matchFixture(fixtures, chatReq)).toBe(fixtures[0]);

    // Image requests do NOT match generic chat fixtures (prevents 500s)
    const imageReq: ChatCompletionRequest = {
      model: "dall-e-3",
      messages: [{ role: "user", content: "guitar" }],
      _endpointType: "image",
    };
    expect(matchFixture(fixtures, imageReq)).toBeNull();
  });

  test("endpoint filtering works with sequenceIndex", () => {
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "g", endpoint: "image", sequenceIndex: 0 },
        response: { image: { url: "1.png" } },
      },
      {
        match: { userMessage: "g", endpoint: "image", sequenceIndex: 1 },
        response: { image: { url: "2.png" } },
      },
    ];
    const counts = new Map<Fixture, number>();
    const imageReq: ChatCompletionRequest = {
      model: "dall-e-3",
      messages: [{ role: "user", content: "g" }],
      _endpointType: "image",
    };

    const first = matchFixture(fixtures, imageReq, counts);
    expect(first).toBe(fixtures[0]);
  });
});

/**
 * Google Gemini Interactions API drift tests.
 *
 * Three-way comparison: SDK types x real API x aimock output.
 *
 * The Interactions API is in Beta — shapes may shift as Google
 * iterates on the endpoint.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { ServerInstance } from "../../server.js";
import {
  extractShape,
  triangulate,
  compareSSESequences,
  formatDriftReport,
  shouldFail,
} from "./schema.js";
import {
  geminiInteractionsResponseShape,
  geminiInteractionsToolCallResponseShape,
  geminiInteractionsStreamEventShapes,
  geminiInteractionsToolCallStreamEventShapes,
} from "./sdk-shapes.js";
import { geminiInteractionsNonStreaming, geminiInteractionsStreaming } from "./providers.js";
import { httpPost, parseInteractionsSSE, startDriftServer, stopDriftServer } from "./helpers.js";

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

let instance: ServerInstance;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;

beforeAll(async () => {
  instance = await startDriftServer();
});

afterAll(async () => {
  await stopDriftServer(instance);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!GOOGLE_API_KEY)("Gemini Interactions API drift", () => {
  const config = { apiKey: GOOGLE_API_KEY! };

  it("non-streaming text shape matches", async () => {
    const sdkShape = geminiInteractionsResponseShape();

    const [realRes, mockRes] = await Promise.all([
      geminiInteractionsNonStreaming(config, "Say hello"),
      httpPost(`${instance.url}/v1beta/interactions`, {
        model: "gemini-2.5-flash",
        input: "Say hello",
        stream: false,
      }),
    ]);

    const realShape = extractShape(realRes.body);
    const mockShape = extractShape(JSON.parse(mockRes.body));

    const diffs = triangulate(sdkShape, realShape, mockShape);
    const report = formatDriftReport("Gemini Interactions (non-streaming text)", diffs);

    if (shouldFail(diffs)) {
      expect.soft([], report).toEqual(diffs.filter((d) => d.severity === "critical"));
    }
  });

  it("streaming text event sequence and shapes match", async () => {
    const sdkEvents = geminiInteractionsStreamEventShapes();

    const [realStream, mockStreamRes] = await Promise.all([
      geminiInteractionsStreaming(config, "Say hello"),
      httpPost(`${instance.url}/v1beta/interactions`, {
        model: "gemini-2.5-flash",
        input: "Say hello",
        stream: true,
      }),
    ]);

    expect(realStream.rawEvents.length, "Real API returned no SSE events").toBeGreaterThan(0);

    const mockEvents = parseInteractionsSSE(mockStreamRes.body);
    expect(mockEvents.length, "Mock returned no SSE events").toBeGreaterThan(0);

    const mockSSEShapes = mockEvents.map((e) => ({
      type: e.event_type,
      dataShape: extractShape(e.data),
    }));

    const diffs = compareSSESequences(sdkEvents, realStream.events, mockSSEShapes);
    const report = formatDriftReport("Gemini Interactions (streaming text events)", diffs);

    if (shouldFail(diffs)) {
      expect.soft([], report).toEqual(diffs.filter((d) => d.severity === "critical"));
    }
  });

  it("non-streaming tool call shape matches", async () => {
    const sdkShape = geminiInteractionsToolCallResponseShape();

    const tools = [
      {
        type: "function",
        name: "get_weather",
        description: "Get weather",
        parameters: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
      },
    ];

    const [realRes, mockRes] = await Promise.all([
      geminiInteractionsNonStreaming(config, "Weather in Paris", tools),
      httpPost(`${instance.url}/v1beta/interactions`, {
        model: "gemini-2.5-flash",
        input: "Weather in Paris",
        stream: false,
        tools,
      }),
    ]);

    const realShape = extractShape(realRes.body);
    const mockShape = extractShape(JSON.parse(mockRes.body));

    const diffs = triangulate(sdkShape, realShape, mockShape);
    const report = formatDriftReport("Gemini Interactions (non-streaming tool call)", diffs);

    if (shouldFail(diffs)) {
      expect.soft([], report).toEqual(diffs.filter((d) => d.severity === "critical"));
    }
  });

  it("streaming tool call event sequence matches", async () => {
    const sdkEvents = geminiInteractionsToolCallStreamEventShapes();

    const tools = [
      {
        type: "function",
        name: "get_weather",
        description: "Get weather",
        parameters: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
      },
    ];

    const [realStream, mockStreamRes] = await Promise.all([
      geminiInteractionsStreaming(config, "Weather in Paris", tools),
      httpPost(`${instance.url}/v1beta/interactions`, {
        model: "gemini-2.5-flash",
        input: "Weather in Paris",
        stream: true,
        tools,
      }),
    ]);

    expect(realStream.rawEvents.length, "Real API returned no SSE events").toBeGreaterThan(0);

    const mockEvents = parseInteractionsSSE(mockStreamRes.body);
    expect(mockEvents.length, "Mock returned no SSE events").toBeGreaterThan(0);

    const mockSSEShapes = mockEvents.map((e) => ({
      type: e.event_type,
      dataShape: extractShape(e.data),
    }));

    const diffs = compareSSESequences(sdkEvents, realStream.events, mockSSEShapes);
    const report = formatDriftReport("Gemini Interactions (streaming tool call events)", diffs);

    if (shouldFail(diffs)) {
      expect.soft([], report).toEqual(diffs.filter((d) => d.severity === "critical"));
    }
  });
});

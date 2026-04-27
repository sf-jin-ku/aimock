import type http from "node:http";
import type { ChatCompletionRequest, Fixture, HandlerDefaults } from "./types.js";
import {
  isAudioResponse,
  isTextResponse,
  isErrorResponse,
  FORMAT_TO_CONTENT_TYPE,
} from "./helpers.js";
import { matchFixture } from "./router.js";
import { writeErrorResponse } from "./sse-writer.js";
import { proxyAndRecord } from "./recorder.js";

export async function handleElevenLabsAudio(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  body: string,
  fixtures: Fixture[],
  defaults: HandlerDefaults,
  matchCounts: Map<Fixture, number>,
  subType: string, // "sound-generation" | "music" | "stream" | "plan"
): Promise<void> {
  // Parse JSON body
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body) as Record<string, unknown>;
  } catch {
    writeErrorResponse(
      res,
      400,
      JSON.stringify({
        error: { message: "Malformed JSON", type: "invalid_request_error", code: "invalid_json" },
      }),
    );
    return;
  }

  // Extract prompt text based on subType
  let promptText: string | undefined;
  if (subType === "sound-generation") {
    if (typeof parsed.text === "string" && parsed.text) {
      promptText = parsed.text;
    }
  } else {
    // music, music-stream, music-plan all use "prompt" (or composition_plan fallback)
    if (typeof parsed.prompt === "string" && parsed.prompt) {
      promptText = parsed.prompt;
    } else if (parsed.composition_plan != null) {
      promptText =
        typeof parsed.composition_plan === "string"
          ? parsed.composition_plan
          : JSON.stringify(parsed.composition_plan);
    }
  }

  // Validate required field
  if (!promptText) {
    const field = subType === "sound-generation" ? "text" : "prompt";
    writeErrorResponse(
      res,
      400,
      JSON.stringify({
        error: {
          message: `Missing required parameter: '${field}'`,
          type: "invalid_request_error",
        },
      }),
    );
    return;
  }

  // Build synthetic ChatCompletionRequest for fixture matching
  const syntheticReq: ChatCompletionRequest = {
    model:
      (parsed.model_id as string) ??
      (subType === "sound-generation" ? "eleven_text_to_sound_v2" : "music_v1"),
    messages: [{ role: "user", content: promptText }],
    _endpointType: "audio-gen",
  };

  // Match fixture
  const fixture = matchFixture(fixtures, syntheticReq, matchCounts, defaults.requestTransform);

  // No fixture match
  if (!fixture) {
    if (defaults.record) {
      const proxied = await proxyAndRecord(
        req,
        res,
        syntheticReq,
        "openai",
        req.url ?? "/v1/sound-generation",
        fixtures,
        defaults,
        body,
      );
      if (proxied) return;
    }

    const strictStatus = defaults.strict ? 503 : 404;
    const strictMessage = defaults.strict
      ? "Strict mode: no fixture matched"
      : "No fixture matched";
    writeErrorResponse(
      res,
      strictStatus,
      JSON.stringify({
        error: { message: strictMessage, type: "invalid_request_error", code: "no_fixture_match" },
      }),
    );
    return;
  }

  const response = fixture.response;

  // Error fixture
  if (isErrorResponse(response)) {
    const status = response.status ?? 500;
    writeErrorResponse(res, status, JSON.stringify(response));
    return;
  }

  // plan returns JSON text, not audio
  if (subType === "plan") {
    if (!isTextResponse(response)) {
      writeErrorResponse(
        res,
        500,
        JSON.stringify({
          error: {
            message: "Fixture response is not a text type for plan endpoint",
            type: "server_error",
          },
        }),
      );
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(response.content);
    return;
  }

  // All other subTypes expect audio
  if (!isAudioResponse(response)) {
    writeErrorResponse(
      res,
      500,
      JSON.stringify({
        error: { message: "Fixture response is not an audio type", type: "server_error" },
      }),
    );
    return;
  }

  // Decode audio bytes and determine content type
  let audioBytes: Buffer;
  let contentType: string;

  if (typeof response.audio === "string") {
    audioBytes = Buffer.from(response.audio, "base64");
    const format = response.format ?? "mp3";
    contentType = FORMAT_TO_CONTENT_TYPE[format] ?? "audio/mpeg";
  } else {
    audioBytes = Buffer.from(response.audio.b64Json, "base64");
    contentType = response.audio.contentType ?? "audio/mpeg";
  }

  // Music endpoints get a song-id header
  if (subType === "music" || subType === "stream") {
    res.setHeader("song-id", "mock-song-" + Date.now());
  }

  // Stream uses chunked transfer encoding
  if (subType === "stream") {
    res.writeHead(200, {
      "Content-Type": contentType,
      "Transfer-Encoding": "chunked",
    });
    res.end(audioBytes);
    return;
  }

  // Standard binary response for sound-generation and music
  res.writeHead(200, { "Content-Type": contentType });
  res.end(audioBytes);
}

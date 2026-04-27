import type http from "node:http";
import type { Fixture } from "./types.js";
import type { HandlerDefaults } from "./types.js";

export async function handleElevenLabsAudio(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  body: string,
  fixtures: Fixture[],
  defaults: HandlerDefaults,
  matchCounts: Map<Fixture, number>,
  subType: string, // "sound-generation" | "music" | "music-stream" | "music-plan"
): Promise<void> {
  // Stub — consume params to satisfy linter until implementation lands
  void body;
  void fixtures;
  void defaults;
  void matchCounts;
  void subType;
  res.writeHead(501, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: { message: "ElevenLabs audio handler not yet implemented" } }));
}

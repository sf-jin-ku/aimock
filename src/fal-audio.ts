import type http from "node:http";
import type { Fixture } from "./types.js";
import type { HandlerDefaults } from "./types.js";

export async function handleFalQueue(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  body: string,
  pathname: string,
  fixtures: Fixture[],
  defaults: HandlerDefaults,
  matchCounts: Map<Fixture, number>,
): Promise<void> {
  // Stub — consume params to satisfy linter until implementation lands
  void body;
  void pathname;
  void fixtures;
  void defaults;
  void matchCounts;
  res.writeHead(501, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: { message: "fal.ai audio handler not yet implemented" } }));
}

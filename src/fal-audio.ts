import type http from "node:http";
import crypto from "node:crypto";
import type { AudioResponse, ChatCompletionRequest, Fixture, HandlerDefaults } from "./types.js";
import { isAudioResponse, isErrorResponse, FORMAT_TO_CONTENT_TYPE, getTestId } from "./helpers.js";
import { matchFixture } from "./router.js";

// ─── FalJobMap with TTL and size bound ───────────────────────────────────

const FAL_JOB_MAX_ENTRIES = 10_000;
const FAL_JOB_TTL_MS = 3_600_000; // 1 hour

interface FalJob {
  requestId: string;
  modelId: string;
  status: "IN_QUEUE" | "IN_PROGRESS" | "COMPLETED";
  result: Record<string, unknown> | null;
  createdAt: number;
}

interface FalJobEntry {
  job: FalJob;
  createdAt: number;
}

/**
 * A Map wrapper for fal.ai queue jobs that enforces a maximum size and per-entry TTL.
 * Entries older than FAL_JOB_TTL_MS are lazily evicted on `get`.
 * When the map exceeds FAL_JOB_MAX_ENTRIES on `set`, the oldest entries
 * are removed to stay within bounds.
 */
export class FalJobMap {
  private readonly entries = new Map<string, FalJobEntry>();

  get(key: string): FalJob | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.createdAt > FAL_JOB_TTL_MS) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.job;
  }

  set(key: string, job: FalJob): void {
    this.entries.set(key, { job, createdAt: Date.now() });
    // Evict oldest entries if over capacity
    if (this.entries.size > FAL_JOB_MAX_ENTRIES) {
      const excess = this.entries.size - FAL_JOB_MAX_ENTRIES;
      const iter = this.entries.keys();
      for (let i = 0; i < excess; i++) {
        const next = iter.next();
        if (!next.done) this.entries.delete(next.value);
      }
    }
  }

  delete(key: string): boolean {
    return this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

// Module-level singleton — shared across all requests
const falJobs = new FalJobMap();

// ─── Audio response translation ──────────────────────────────────────────

function audioToFalFile(response: AudioResponse): Record<string, unknown> {
  let contentType: string;
  let data: string;

  if (typeof response.audio === "string") {
    data = response.audio;
    contentType = FORMAT_TO_CONTENT_TYPE[response.format ?? "mp3"] ?? "audio/mpeg";
  } else {
    data = response.audio.b64Json;
    contentType = response.audio.contentType ?? "audio/mp3";
  }

  const ext = response.format ?? "mp3";

  return {
    audio: {
      url: `https://mock.fal.media/files/generated_audio.${ext}`,
      content_type: contentType,
      file_name: `generated_audio.${ext}`,
      file_size: Math.ceil((data.length * 3) / 4), // approximate decoded size from base64
    },
  };
}

// ─── Route patterns ──────────────────────────────────────────────────────

const QUEUE_SUBMIT_RE = /^\/fal\/queue\/submit\/(.+)$/;
const QUEUE_STATUS_RE = /^\/fal\/queue\/requests\/([^/]+)\/status$/;
const QUEUE_RESULT_RE = /^\/fal\/queue\/requests\/([^/]+)$/;
const QUEUE_CANCEL_RE = /^\/fal\/queue\/requests\/([^/]+)\/cancel$/;
const SYNC_RUN_RE = /^\/fal\/run\/(.+)$/;

// ─── Handler ─────────────────────────────────────────────────────────────

export async function handleFalQueue(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  body: string,
  pathname: string,
  fixtures: Fixture[],
  defaults: HandlerDefaults,
  matchCounts: Map<Fixture, number>,
): Promise<void> {
  const testId = getTestId(req);

  // ── Queue Submit ───────────────────────────────────────────────────
  const submitMatch = QUEUE_SUBMIT_RE.exec(pathname);
  if (submitMatch && req.method === "POST") {
    const modelId = submitMatch[1];
    return handleQueueSubmit(req, res, body, modelId, testId, fixtures, defaults, matchCounts);
  }

  // ── Queue Status ───────────────────────────────────────────────────
  const statusMatch = QUEUE_STATUS_RE.exec(pathname);
  if (statusMatch) {
    const requestId = statusMatch[1];
    return handleQueueStatus(res, requestId, testId);
  }

  // ── Queue Cancel ───────────────────────────────────────────────────
  const cancelMatch = QUEUE_CANCEL_RE.exec(pathname);
  if (cancelMatch) {
    const requestId = cancelMatch[1];
    return handleQueueCancel(res, requestId, testId);
  }

  // ── Queue Result ───────────────────────────────────────────────────
  const resultMatch = QUEUE_RESULT_RE.exec(pathname);
  if (resultMatch) {
    const requestId = resultMatch[1];
    return handleQueueResult(res, requestId, testId);
  }

  // ── Synchronous Run ────────────────────────────────────────────────
  const runMatch = SYNC_RUN_RE.exec(pathname);
  if (runMatch && req.method === "POST") {
    const modelId = runMatch[1];
    return handleSyncRun(res, body, modelId, fixtures, defaults, matchCounts);
  }

  // Unknown fal path
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: { message: "Unknown fal.ai endpoint", type: "not_found" } }));
}

// ─── Sub-handlers ────────────────────────────────────────────────────────

function handleQueueSubmit(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  body: string,
  modelId: string,
  testId: string,
  fixtures: Fixture[],
  defaults: HandlerDefaults,
  matchCounts: Map<Fixture, number>,
): void {
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(body) as Record<string, unknown>;
  } catch {
    // empty body is fine — prompt might not be required for some models
  }

  const prompt =
    (typeof parsed.prompt === "string" ? parsed.prompt : null) ??
    (typeof parsed.text === "string" ? parsed.text : null) ??
    "";

  const syntheticReq: ChatCompletionRequest = {
    model: modelId,
    messages: [{ role: "user", content: prompt }],
    _endpointType: "fal-audio",
  };

  const fixture = matchFixture(fixtures, syntheticReq, matchCounts, defaults.requestTransform);

  if (!fixture) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: {
          message: "No fixture matched",
          type: "invalid_request_error",
          code: "no_fixture_match",
        },
      }),
    );
    return;
  }

  const response = fixture.response;

  if (isErrorResponse(response)) {
    const status = response.status ?? 500;
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(response));
    return;
  }

  if (!isAudioResponse(response)) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: { message: "Fixture response is not an audio type", type: "server_error" },
      }),
    );
    return;
  }

  const requestId = crypto.randomUUID();
  const result = audioToFalFile(response);

  const job: FalJob = {
    requestId,
    modelId,
    status: "COMPLETED",
    result,
    createdAt: Date.now(),
  };

  const stateKey = `${testId}:${requestId}`;
  falJobs.set(stateKey, job);

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      request_id: requestId,
      response_url: `https://queue.fal.run/${modelId}/requests/${requestId}/response`,
      status_url: `https://queue.fal.run/${modelId}/requests/${requestId}/status`,
      cancel_url: `https://queue.fal.run/${modelId}/requests/${requestId}/cancel`,
      queue_position: 0,
    }),
  );
}

function handleQueueStatus(res: http.ServerResponse, requestId: string, testId: string): void {
  const stateKey = `${testId}:${requestId}`;
  const job = falJobs.get(stateKey);

  if (!job) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: { message: `Request ${requestId} not found`, type: "not_found" },
      }),
    );
    return;
  }

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      status: job.status,
      request_id: job.requestId,
      response_url: `https://queue.fal.run/${job.modelId}/requests/${requestId}/response`,
    }),
  );
}

function handleQueueResult(res: http.ServerResponse, requestId: string, testId: string): void {
  const stateKey = `${testId}:${requestId}`;
  const job = falJobs.get(stateKey);

  if (!job) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: { message: `Request ${requestId} not found`, type: "not_found" },
      }),
    );
    return;
  }

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(job.result));
}

function handleQueueCancel(res: http.ServerResponse, requestId: string, testId: string): void {
  const stateKey = `${testId}:${requestId}`;
  const job = falJobs.get(stateKey);

  if (!job) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "NOT_FOUND" }));
    return;
  }

  // Since we complete immediately, cancellation always returns ALREADY_COMPLETED
  res.writeHead(400, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ status: "ALREADY_COMPLETED" }));
}

function handleSyncRun(
  res: http.ServerResponse,
  body: string,
  modelId: string,
  fixtures: Fixture[],
  defaults: HandlerDefaults,
  matchCounts: Map<Fixture, number>,
): void {
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(body) as Record<string, unknown>;
  } catch {
    // empty body is fine
  }

  const prompt =
    (typeof parsed.prompt === "string" ? parsed.prompt : null) ??
    (typeof parsed.text === "string" ? parsed.text : null) ??
    "";

  const syntheticReq: ChatCompletionRequest = {
    model: modelId,
    messages: [{ role: "user", content: prompt }],
    _endpointType: "fal-audio",
  };

  const fixture = matchFixture(fixtures, syntheticReq, matchCounts, defaults.requestTransform);

  if (!fixture) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: {
          message: "No fixture matched",
          type: "invalid_request_error",
          code: "no_fixture_match",
        },
      }),
    );
    return;
  }

  const response = fixture.response;

  if (isErrorResponse(response)) {
    const status = response.status ?? 500;
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(response));
    return;
  }

  if (!isAudioResponse(response)) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: { message: "Fixture response is not an audio type", type: "server_error" },
      }),
    );
    return;
  }

  const result = audioToFalFile(response);

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(result));
}

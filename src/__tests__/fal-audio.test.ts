import { describe, test, expect, afterEach } from "vitest";
import { LLMock } from "../llmock.js";

describe("fal.ai audio queue", () => {
  let mock: LLMock;

  afterEach(async () => {
    await mock?.stop();
  });

  test("queue submit returns queue envelope", async () => {
    mock = new LLMock({ port: 0 });
    mock.onFalAudio("drum loop", { audio: "SGVsbG8=", format: "mp3" });
    await mock.start();

    const res = await fetch(`${mock.url}/fal/queue/submit/fal-ai/stable-audio`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "drum loop" }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.request_id).toBeDefined();
    expect(typeof data.request_id).toBe("string");
    expect(data.response_url).toContain(data.request_id);
    expect(data.status_url).toContain(data.request_id);
    expect(data.cancel_url).toContain(data.request_id);
    expect(data.queue_position).toBe(0);
  });

  test("queue status returns COMPLETED", async () => {
    mock = new LLMock({ port: 0 });
    mock.onFalAudio("drum loop", { audio: "SGVsbG8=", format: "mp3" });
    await mock.start();

    // Submit first
    const submit = await fetch(`${mock.url}/fal/queue/submit/fal-ai/stable-audio`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "drum loop" }),
    });
    const envelope = await submit.json();

    // Check status
    const status = await fetch(`${mock.url}/fal/queue/requests/${envelope.request_id}/status`);
    expect(status.status).toBe(200);
    const statusData = await status.json();
    expect(statusData.status).toBe("COMPLETED");
    expect(statusData.request_id).toBe(envelope.request_id);
    expect(statusData.response_url).toBeDefined();
  });

  test("queue result returns audio file object", async () => {
    mock = new LLMock({ port: 0 });
    mock.onFalAudio("drum loop", { audio: "SGVsbG8=", format: "mp3" });
    await mock.start();

    // Submit
    const submit = await fetch(`${mock.url}/fal/queue/submit/fal-ai/stable-audio`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "drum loop" }),
    });
    const envelope = await submit.json();

    // Get result
    const result = await fetch(`${mock.url}/fal/queue/requests/${envelope.request_id}`);
    expect(result.status).toBe(200);
    const data = await result.json();
    expect(data.audio).toBeDefined();
    expect(data.audio.url).toContain("generated_audio.mp3");
    expect(data.audio.content_type).toBe("audio/mpeg");
    expect(data.audio.file_name).toBe("generated_audio.mp3");
    expect(typeof data.audio.file_size).toBe("number");
    expect(data.audio.file_size).toBeGreaterThan(0);
  });

  test("full queue lifecycle: submit -> status -> result", async () => {
    mock = new LLMock({ port: 0 });
    mock.onFalAudio("synth pad", { audio: "AAAA", format: "wav" });
    await mock.start();

    // Submit
    const submit = await fetch(`${mock.url}/fal/queue/submit/fal-ai/stable-audio`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "synth pad" }),
    });
    expect(submit.status).toBe(200);
    const envelope = await submit.json();
    const requestId = envelope.request_id;

    // Status
    const status = await fetch(`${mock.url}/fal/queue/requests/${requestId}/status`);
    expect(status.status).toBe(200);
    const statusData = await status.json();
    expect(statusData.status).toBe("COMPLETED");

    // Result
    const result = await fetch(`${mock.url}/fal/queue/requests/${requestId}`);
    expect(result.status).toBe(200);
    const resultData = await result.json();
    expect(resultData.audio.url).toContain("generated_audio.wav");
    expect(resultData.audio.content_type).toBe("audio/wav");
  });

  test("synchronous run returns result directly", async () => {
    mock = new LLMock({ port: 0 });
    mock.onFalAudio("drum loop", { audio: "SGVsbG8=", format: "mp3" });
    await mock.start();

    const res = await fetch(`${mock.url}/fal/run/fal-ai/stable-audio`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "drum loop" }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    // Synchronous run returns result directly, no queue envelope
    expect(data.audio).toBeDefined();
    expect(data.audio.url).toContain("generated_audio.mp3");
    expect(data.audio.content_type).toBe("audio/mpeg");
    expect(data.request_id).toBeUndefined(); // no queue envelope
  });

  test("cancel returns ALREADY_COMPLETED", async () => {
    mock = new LLMock({ port: 0 });
    mock.onFalAudio("drum loop", { audio: "SGVsbG8=" });
    await mock.start();

    // Submit
    const submit = await fetch(`${mock.url}/fal/queue/submit/fal-ai/stable-audio`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "drum loop" }),
    });
    const envelope = await submit.json();

    // Cancel
    const cancel = await fetch(`${mock.url}/fal/queue/requests/${envelope.request_id}/cancel`, {
      method: "PUT",
    });
    expect(cancel.status).toBe(400);
    const cancelData = await cancel.json();
    expect(cancelData.status).toBe("ALREADY_COMPLETED");
  });

  test("unknown request_id returns 404", async () => {
    mock = new LLMock({ port: 0 });
    await mock.start();

    const res = await fetch(`${mock.url}/fal/queue/requests/nonexistent/status`);
    expect(res.status).toBe(404);
  });

  test("object-form audio response with contentType", async () => {
    mock = new LLMock({ port: 0 });
    mock.onFalAudio("speech", {
      audio: { b64Json: "SGVsbG8=", contentType: "audio/wav" },
    });
    await mock.start();

    // Submit
    const submit = await fetch(`${mock.url}/fal/queue/submit/fal-ai/stable-audio`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "speech" }),
    });
    const envelope = await submit.json();

    // Get result
    const result = await fetch(`${mock.url}/fal/queue/requests/${envelope.request_id}`);
    const data = await result.json();
    expect(data.audio.content_type).toBe("audio/wav");
  });

  test("onFalAudio convenience method registers fixture correctly", async () => {
    mock = new LLMock({ port: 0 });
    mock.onFalAudio("loop", { audio: "SGVsbG8=" });
    await mock.start();

    const submit = await fetch(`${mock.url}/fal/queue/submit/fal-ai/stable-audio`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "loop" }),
    });
    expect(submit.status).toBe(200);
    const envelope = await submit.json();
    expect(envelope.request_id).toBeDefined();

    // Verify result is retrievable
    const result = await fetch(`${mock.url}/fal/queue/requests/${envelope.request_id}`);
    expect(result.status).toBe(200);
    const data = await result.json();
    expect(data.audio).toBeDefined();
  });

  test("no matching fixture returns 404", async () => {
    mock = new LLMock({ port: 0 });
    mock.onFalAudio("specific prompt", { audio: "SGVsbG8=" });
    await mock.start();

    const res = await fetch(`${mock.url}/fal/queue/submit/fal-ai/stable-audio`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "completely different" }),
    });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error.message).toContain("No fixture matched");
  });

  test("error fixture returns error status", async () => {
    mock = new LLMock({ port: 0 });
    mock.addFixture({
      match: { userMessage: "quota", endpoint: "fal-audio" },
      response: { error: { message: "quota exceeded", type: "rate_limit" }, status: 429 },
    });
    await mock.start();

    const res = await fetch(`${mock.url}/fal/queue/submit/fal-ai/stable-audio`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "quota" }),
    });
    expect(res.status).toBe(429);
    const data = await res.json();
    expect(data.error.message).toBe("quota exceeded");
  });

  test("X-Test-Id isolation for fal queue jobs", async () => {
    mock = new LLMock({ port: 0 });
    mock.onFalAudio("drum", { audio: "SGVsbG8=" });
    await mock.start();

    // Submit with test-id A
    const submitA = await fetch(`${mock.url}/fal/queue/submit/fal-ai/stable-audio`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-Id": "testA" },
      body: JSON.stringify({ prompt: "drum" }),
    });
    const envelopeA = await submitA.json();

    // Submit with test-id B
    const submitB = await fetch(`${mock.url}/fal/queue/submit/fal-ai/stable-audio`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-Id": "testB" },
      body: JSON.stringify({ prompt: "drum" }),
    });
    const envelopeB = await submitB.json();

    // A's request_id should not be visible to B
    const crossLookup = await fetch(
      `${mock.url}/fal/queue/requests/${envelopeA.request_id}/status`,
      { headers: { "X-Test-Id": "testB" } },
    );
    expect(crossLookup.status).toBe(404);

    // A's request_id should be visible to A
    const sameLookup = await fetch(
      `${mock.url}/fal/queue/requests/${envelopeA.request_id}/status`,
      { headers: { "X-Test-Id": "testA" } },
    );
    expect(sameLookup.status).toBe(200);

    // B's request_id should be visible to B
    const bLookup = await fetch(`${mock.url}/fal/queue/requests/${envelopeB.request_id}/status`, {
      headers: { "X-Test-Id": "testB" },
    });
    expect(bLookup.status).toBe(200);
  });
});

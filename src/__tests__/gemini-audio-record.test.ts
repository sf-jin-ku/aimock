import { describe, it, expect } from "vitest";
import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { proxyAndRecord } from "../recorder.js";
import type { Fixture, RecordConfig, ChatCompletionRequest } from "../types.js";
import { Logger } from "../logger.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createUpstream(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ server: http.Server; url: string }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({ server, url: `http://127.0.0.1:${addr.port}` });
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function createMockReqRes(
  urlPath: string,
  headers: Record<string, string> = {},
): { req: http.IncomingMessage; res: http.ServerResponse; getResponse: () => Promise<string> } {
  const chunks: Buffer[] = [];
  let statusCode = 200;

  const req = {
    method: "POST",
    url: urlPath,
    headers: { "content-type": "application/json", ...headers },
  } as unknown as http.IncomingMessage;

  const res = {
    statusCode,
    headersSent: false,
    destroyed: false,
    writableEnded: false,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    writeHead(status: number, hdrs?: Record<string, string>) {
      statusCode = status;
      res.statusCode = status;
      (res as unknown as { headersSent: boolean }).headersSent = true;
    },
    write(data: string | Buffer) {
      chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
      return true;
    },
    end(data?: string | Buffer) {
      if (data) chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
      (res as unknown as { writableEnded: boolean }).writableEnded = true;
    },
    setHeader() {},
    flushHeaders() {},
    on() {
      return res;
    },
  } as unknown as http.ServerResponse;

  return {
    req,
    res,
    getResponse: async () => Buffer.concat(chunks).toString(),
  };
}

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aimock-gemini-audio-"));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Gemini audio recording: non-streaming JSON", () => {
  it("records non-streaming Gemini audio response as AudioResponse", async () => {
    const fixturePath = makeTmpDir();
    const { server, url } = await createUpstream((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          candidates: [
            {
              content: {
                role: "model",
                parts: [{ inlineData: { mimeType: "audio/mp3", data: "SGVsbG8=" } }],
              },
              finishReason: "STOP",
            },
          ],
        }),
      );
    });

    try {
      const fixtures: Fixture[] = [];
      const record: RecordConfig = { providers: { gemini: url }, fixturePath };
      const logger = new Logger("silent");
      const request: ChatCompletionRequest = {
        model: "gemini-2.0-flash",
        messages: [{ role: "user", content: "say hello" }],
      };

      const { req, res } = createMockReqRes("/v1beta/models/gemini-2.0-flash:generateContent");
      await proxyAndRecord(
        req,
        res,
        request,
        "gemini",
        "/v1beta/models/gemini-2.0-flash:generateContent",
        fixtures,
        { record, logger },
      );

      expect(fixtures).toHaveLength(1);
      const response = fixtures[0].response as {
        audio?: { b64Json: string; contentType?: string };
      };
      expect(response.audio).toBeDefined();
      expect(response.audio!.b64Json).toBe("SGVsbG8=");
      expect(response.audio!.contentType).toBe("audio/mp3");
    } finally {
      await closeServer(server);
      fs.rmSync(fixturePath, { recursive: true, force: true });
    }
  });
});

describe("Gemini audio recording: streaming SSE", () => {
  it("records streaming Gemini SSE audio response as AudioResponse", async () => {
    const fixturePath = makeTmpDir();
    const chunk1 = JSON.stringify({
      candidates: [
        {
          content: {
            parts: [{ inlineData: { mimeType: "audio/mp3", data: "AAAA" } }],
          },
        },
      ],
    });
    const chunk2 = JSON.stringify({
      candidates: [
        {
          content: {
            parts: [{ inlineData: { mimeType: "audio/mp3", data: "BBBB" } }],
          },
        },
      ],
    });
    const sseBody = `data: ${chunk1}\n\ndata: ${chunk2}\n\n`;

    const { server, url } = await createUpstream((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(sseBody);
    });

    try {
      const fixtures: Fixture[] = [];
      const record: RecordConfig = { providers: { gemini: url }, fixturePath };
      const logger = new Logger("silent");
      const request: ChatCompletionRequest = {
        model: "gemini-2.0-flash",
        messages: [{ role: "user", content: "stream audio" }],
        stream: true,
      };

      const { req, res } = createMockReqRes(
        "/v1beta/models/gemini-2.0-flash:streamGenerateContent",
      );
      await proxyAndRecord(
        req,
        res,
        request,
        "gemini",
        "/v1beta/models/gemini-2.0-flash:streamGenerateContent",
        fixtures,
        { record, logger },
      );

      expect(fixtures).toHaveLength(1);
      const response = fixtures[0].response as {
        audio?: { b64Json: string; contentType?: string };
      };
      expect(response.audio).toBeDefined();
      expect(response.audio!.b64Json).toBe("AAAABBBB");
      expect(response.audio!.contentType).toBe("audio/mp3");
    } finally {
      await closeServer(server);
      fs.rmSync(fixturePath, { recursive: true, force: true });
    }
  });
});

describe("Gemini audio recording: audio priority over text", () => {
  it("audio parts take priority over text parts in non-streaming", async () => {
    const fixturePath = makeTmpDir();
    const { server, url } = await createUpstream((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          candidates: [
            {
              content: {
                role: "model",
                parts: [
                  { text: "Here is the audio" },
                  { inlineData: { mimeType: "audio/wav", data: "UklGRg==" } },
                ],
              },
              finishReason: "STOP",
            },
          ],
        }),
      );
    });

    try {
      const fixtures: Fixture[] = [];
      const record: RecordConfig = { providers: { gemini: url }, fixturePath };
      const logger = new Logger("silent");
      const request: ChatCompletionRequest = {
        model: "gemini-2.0-flash",
        messages: [{ role: "user", content: "audio with text" }],
      };

      const { req, res } = createMockReqRes("/v1beta/models/gemini-2.0-flash:generateContent");
      await proxyAndRecord(
        req,
        res,
        request,
        "gemini",
        "/v1beta/models/gemini-2.0-flash:generateContent",
        fixtures,
        { record, logger },
      );

      expect(fixtures).toHaveLength(1);
      const response = fixtures[0].response as {
        audio?: { b64Json: string; contentType?: string };
        content?: string;
      };
      // Audio should take priority — no content field
      expect(response.audio).toBeDefined();
      expect(response.audio!.b64Json).toBe("UklGRg==");
      expect(response.audio!.contentType).toBe("audio/wav");
      expect(response.content).toBeUndefined();
    } finally {
      await closeServer(server);
      fs.rmSync(fixturePath, { recursive: true, force: true });
    }
  });
});

describe("Gemini audio recording: replay after record", () => {
  it("recorded fixture matches on replay", async () => {
    const fixturePath = makeTmpDir();
    const { server, url } = await createUpstream((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          candidates: [
            {
              content: {
                role: "model",
                parts: [{ inlineData: { mimeType: "audio/mp3", data: "dGVzdA==" } }],
              },
              finishReason: "STOP",
            },
          ],
        }),
      );
    });

    try {
      const fixtures: Fixture[] = [];
      const record: RecordConfig = { providers: { gemini: url }, fixturePath };
      const logger = new Logger("silent");
      const request: ChatCompletionRequest = {
        model: "gemini-2.0-flash",
        messages: [{ role: "user", content: "replay test" }],
      };

      // First call: record
      const { req: req1, res: res1 } = createMockReqRes(
        "/v1beta/models/gemini-2.0-flash:generateContent",
      );
      await proxyAndRecord(
        req1,
        res1,
        request,
        "gemini",
        "/v1beta/models/gemini-2.0-flash:generateContent",
        fixtures,
        { record, logger },
      );

      expect(fixtures).toHaveLength(1);
      const recorded = fixtures[0];
      expect(recorded.match.userMessage).toBe("replay test");

      // The fixture is now in memory — verify its shape is correct for replay
      const response = recorded.response as {
        audio?: { b64Json: string; contentType?: string };
      };
      expect(response.audio).toBeDefined();
      expect(response.audio!.b64Json).toBe("dGVzdA==");
      expect(response.audio!.contentType).toBe("audio/mp3");

      // Verify fixture was written to disk
      const files = fs.readdirSync(fixturePath).filter((f) => f.endsWith(".json"));
      expect(files.length).toBeGreaterThanOrEqual(1);

      const diskFixture = JSON.parse(
        fs.readFileSync(path.join(fixturePath, files[0]), "utf-8"),
      ) as { fixtures: Array<{ response: { audio?: { b64Json: string; contentType?: string } } }> };
      expect(diskFixture.fixtures[0].response.audio).toBeDefined();
      expect(diskFixture.fixtures[0].response.audio!.b64Json).toBe("dGVzdA==");
    } finally {
      await closeServer(server);
      fs.rmSync(fixturePath, { recursive: true, force: true });
    }
  });
});

describe("Gemini audio recording: non-audio inlineData is ignored", () => {
  it("image inlineData does not produce AudioResponse", async () => {
    const fixturePath = makeTmpDir();
    const { server, url } = await createUpstream((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          candidates: [
            {
              content: {
                role: "model",
                parts: [
                  { text: "Here is an image" },
                  { inlineData: { mimeType: "image/png", data: "iVBORw0KGgo=" } },
                ],
              },
              finishReason: "STOP",
            },
          ],
        }),
      );
    });

    try {
      const fixtures: Fixture[] = [];
      const record: RecordConfig = { providers: { gemini: url }, fixturePath };
      const logger = new Logger("silent");
      const request: ChatCompletionRequest = {
        model: "gemini-2.0-flash",
        messages: [{ role: "user", content: "show image" }],
      };

      const { req, res } = createMockReqRes("/v1beta/models/gemini-2.0-flash:generateContent");
      await proxyAndRecord(
        req,
        res,
        request,
        "gemini",
        "/v1beta/models/gemini-2.0-flash:generateContent",
        fixtures,
        { record, logger },
      );

      expect(fixtures).toHaveLength(1);
      const response = fixtures[0].response as {
        audio?: unknown;
        content?: string;
      };
      // Should NOT be an AudioResponse — image/png is not audio/
      expect(response.audio).toBeUndefined();
      // Should fall through to text extraction
      expect(response.content).toBe("Here is an image");
    } finally {
      await closeServer(server);
      fs.rmSync(fixturePath, { recursive: true, force: true });
    }
  });
});

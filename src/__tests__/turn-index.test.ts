import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { LLMock } from "../llmock.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function chatPost(
  baseUrl: string,
  messages: Array<Record<string, unknown>>,
  extra?: Record<string, unknown>,
) {
  return fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "gpt-4", messages, stream: false, ...extra }),
  });
}

function claudePost(
  baseUrl: string,
  messages: Array<Record<string, unknown>>,
  extra?: Record<string, unknown>,
) {
  return fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": "test-key",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages,
      stream: false,
      ...extra,
    }),
  });
}

function geminiPost(
  baseUrl: string,
  contents: Array<Record<string, unknown>>,
  extra?: Record<string, unknown>,
) {
  return fetch(`${baseUrl}/v1beta/models/gemini-2.0-flash:generateContent?key=test-key`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents, ...extra }),
  });
}

// ---------------------------------------------------------------------------
// 1. turnIndex integration tests
// ---------------------------------------------------------------------------

describe("turnIndex — OpenAI Chat 2-step HITL flow", () => {
  let mock: LLMock;

  beforeAll(async () => {
    mock = new LLMock();
    await mock.start();
  });

  afterAll(async () => {
    await mock.stop();
  });

  it("step 0: no assistant messages → turnIndex 0 matches tool call", async () => {
    mock.reset();
    mock.on(
      { userMessage: "plan a trip to mars", turnIndex: 0 },
      {
        toolCalls: [{ name: "plan_trip", arguments: '{"destination":"mars"}', id: "call_plan_1" }],
      },
    );
    mock.on(
      { userMessage: "plan a trip to mars", turnIndex: 1 },
      { content: "Your trip to Mars is booked!" },
    );

    // Step 0: just user message, no assistant messages → turnIndex 0
    const res0 = await chatPost(mock.url, [{ role: "user", content: "plan a trip to mars" }]);
    expect(res0.status).toBe(200);
    const body0 = (await res0.json()) as {
      choices: {
        message: { tool_calls: { function: { name: string } }[] };
        finish_reason: string;
      }[];
    };
    expect(body0.choices[0].message.tool_calls[0].function.name).toBe("plan_trip");
    expect(body0.choices[0].finish_reason).toBe("tool_calls");
  });

  it("step 1: one assistant message → turnIndex 1 matches text follow-up", async () => {
    mock.reset();
    mock.on(
      { userMessage: "plan a trip to mars", turnIndex: 0 },
      {
        toolCalls: [{ name: "plan_trip", arguments: '{"destination":"mars"}', id: "call_plan_1" }],
      },
    );
    mock.on(
      { userMessage: "plan a trip to mars", turnIndex: 1 },
      { content: "Your trip to Mars is booked!" },
    );

    // Step 1: user + assistant (tool_calls) + tool result → turnIndex 1
    const res1 = await chatPost(mock.url, [
      { role: "user", content: "plan a trip to mars" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_plan_1",
            type: "function",
            function: { name: "plan_trip", arguments: '{"destination":"mars"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_plan_1", content: '{"status":"confirmed"}' },
    ]);
    expect(res1.status).toBe(200);
    const body1 = (await res1.json()) as { choices: { message: { content: string } }[] };
    expect(body1.choices[0].message.content).toBe("Your trip to Mars is booked!");
  });
});

describe("turnIndex — OpenAI Chat 4-step subagent flow", () => {
  let mock: LLMock;

  beforeAll(async () => {
    mock = new LLMock();
    await mock.start();
  });

  afterAll(async () => {
    await mock.stop();
  });

  it("4 turns return distinct content based on turnIndex", async () => {
    mock.reset();
    mock.on({ userMessage: "subagent", turnIndex: 0 }, { content: "turn-0-response" });
    mock.on({ userMessage: "subagent", turnIndex: 1 }, { content: "turn-1-response" });
    mock.on({ userMessage: "subagent", turnIndex: 2 }, { content: "turn-2-response" });
    mock.on({ userMessage: "subagent", turnIndex: 3 }, { content: "turn-3-response" });

    const responses: string[] = [];

    // Turn 0: just user message
    const res0 = await chatPost(mock.url, [{ role: "user", content: "subagent" }]);
    responses.push(
      ((await res0.json()) as { choices: { message: { content: string } }[] }).choices[0].message
        .content,
    );

    // Turn 1: user + 1 assistant
    const res1 = await chatPost(mock.url, [
      { role: "user", content: "subagent" },
      { role: "assistant", content: "turn-0-response" },
    ]);
    responses.push(
      ((await res1.json()) as { choices: { message: { content: string } }[] }).choices[0].message
        .content,
    );

    // Turn 2: user + 2 assistants
    const res2 = await chatPost(mock.url, [
      { role: "user", content: "subagent" },
      { role: "assistant", content: "turn-0-response" },
      { role: "assistant", content: "turn-1-response" },
    ]);
    responses.push(
      ((await res2.json()) as { choices: { message: { content: string } }[] }).choices[0].message
        .content,
    );

    // Turn 3: user + 3 assistants
    const res3 = await chatPost(mock.url, [
      { role: "user", content: "subagent" },
      { role: "assistant", content: "turn-0-response" },
      { role: "assistant", content: "turn-1-response" },
      { role: "assistant", content: "turn-2-response" },
    ]);
    responses.push(
      ((await res3.json()) as { choices: { message: { content: string } }[] }).choices[0].message
        .content,
    );

    expect(responses).toEqual([
      "turn-0-response",
      "turn-1-response",
      "turn-2-response",
      "turn-3-response",
    ]);
  });
});

describe("turnIndex — concurrency (stateless verification)", () => {
  let mock: LLMock;

  beforeAll(async () => {
    mock = new LLMock();
    await mock.start();
  });

  afterAll(async () => {
    await mock.stop();
  });

  it("5 concurrent step-0 and 5 concurrent step-1 all get correct responses", async () => {
    mock.reset();
    mock.on({ userMessage: "concurrent-turn", turnIndex: 0 }, { content: "first-turn" });
    mock.on({ userMessage: "concurrent-turn", turnIndex: 1 }, { content: "second-turn" });

    // Step 0 messages: no assistant messages
    const step0Messages = [{ role: "user", content: "concurrent-turn" }];
    // Step 1 messages: one assistant message
    const step1Messages = [
      { role: "user", content: "concurrent-turn" },
      { role: "assistant", content: "first-turn" },
    ];

    // Fire 5 step-0 and 5 step-1 concurrently
    const allPromises = [
      ...Array.from({ length: 5 }, () => chatPost(mock.url, step0Messages)),
      ...Array.from({ length: 5 }, () => chatPost(mock.url, step1Messages)),
    ];

    const results = await Promise.all(allPromises);

    const step0Results: string[] = [];
    const step1Results: string[] = [];

    for (let i = 0; i < 10; i++) {
      expect(results[i].status).toBe(200);
      const body = (await results[i].json()) as {
        choices: { message: { content: string } }[];
      };
      if (i < 5) {
        step0Results.push(body.choices[0].message.content);
      } else {
        step1Results.push(body.choices[0].message.content);
      }
    }

    // ALL step-0 requests get "first-turn" (no counter drift)
    expect(step0Results).toEqual(Array(5).fill("first-turn"));
    // ALL step-1 requests get "second-turn"
    expect(step1Results).toEqual(Array(5).fill("second-turn"));
  });
});

describe("turnIndex — Anthropic Claude cross-provider", () => {
  let mock: LLMock;

  beforeAll(async () => {
    mock = new LLMock();
    await mock.start();
  });

  afterAll(async () => {
    await mock.stop();
  });

  it("turnIndex 0 and 1 work through Claude message normalization", async () => {
    mock.reset();
    mock.on({ userMessage: "claude-turn", turnIndex: 0 }, { content: "claude-first" });
    mock.on({ userMessage: "claude-turn", turnIndex: 1 }, { content: "claude-second" });

    // Turn 0: just user message → no assistant messages → turnIndex 0
    const res0 = await claudePost(mock.url, [{ role: "user", content: "claude-turn" }]);
    expect(res0.status).toBe(200);
    const body0 = (await res0.json()) as { content: { type: string; text: string }[] };
    expect(body0.content[0].text).toBe("claude-first");

    // Turn 1: user + assistant → 1 assistant message → turnIndex 1
    const res1 = await claudePost(mock.url, [
      { role: "user", content: "claude-turn" },
      { role: "assistant", content: "claude-first" },
      { role: "user", content: "claude-turn" },
    ]);
    expect(res1.status).toBe(200);
    const body1 = (await res1.json()) as { content: { type: string; text: string }[] };
    expect(body1.content[0].text).toBe("claude-second");
  });
});

describe("turnIndex — Gemini cross-provider", () => {
  let mock: LLMock;

  beforeAll(async () => {
    mock = new LLMock();
    await mock.start();
  });

  afterAll(async () => {
    await mock.stop();
  });

  it("turnIndex 0 and 1 work through Gemini content normalization", async () => {
    mock.reset();
    mock.on({ userMessage: "gemini-turn", turnIndex: 0 }, { content: "gemini-first" });
    mock.on({ userMessage: "gemini-turn", turnIndex: 1 }, { content: "gemini-second" });

    // Turn 0: just user content → no model (assistant) contents → turnIndex 0
    const res0 = await geminiPost(mock.url, [{ role: "user", parts: [{ text: "gemini-turn" }] }]);
    expect(res0.status).toBe(200);
    type GeminiBody = {
      candidates: { content: { parts: { text: string }[] } }[];
    };
    const body0 = (await res0.json()) as GeminiBody;
    expect(body0.candidates[0].content.parts[0].text).toBe("gemini-first");

    // Turn 1: user + model (assistant equivalent) → turnIndex 1
    const res1 = await geminiPost(mock.url, [
      { role: "user", parts: [{ text: "gemini-turn" }] },
      { role: "model", parts: [{ text: "gemini-first" }] },
      { role: "user", parts: [{ text: "gemini-turn" }] },
    ]);
    expect(res1.status).toBe(200);
    const body1 = (await res1.json()) as GeminiBody;
    expect(body1.candidates[0].content.parts[0].text).toBe("gemini-second");
  });
});

// ---------------------------------------------------------------------------
// 2. hasToolResult integration tests
// ---------------------------------------------------------------------------

describe("hasToolResult — HITL 2-step discrimination", () => {
  let mock: LLMock;

  beforeAll(async () => {
    mock = new LLMock();
    await mock.start();
  });

  afterAll(async () => {
    await mock.stop();
  });

  it("hasToolResult:false matches when no tool messages; hasToolResult:true matches with tool messages", async () => {
    mock.reset();
    mock.on(
      { userMessage: "weather", hasToolResult: false },
      {
        toolCalls: [{ name: "get_weather", arguments: '{"city":"NYC"}', id: "call_w1" }],
      },
    );
    mock.on(
      { userMessage: "weather", hasToolResult: true },
      { content: "The weather in NYC is sunny, 72F." },
    );

    // First request: no tool messages → hasToolResult false → tool call
    const res0 = await chatPost(mock.url, [{ role: "user", content: "weather" }]);
    expect(res0.status).toBe(200);
    const body0 = (await res0.json()) as {
      choices: {
        message: { tool_calls: { function: { name: string } }[] };
        finish_reason: string;
      }[];
    };
    expect(body0.choices[0].message.tool_calls[0].function.name).toBe("get_weather");
    expect(body0.choices[0].finish_reason).toBe("tool_calls");

    // Second request: includes tool result → hasToolResult true → text
    const res1 = await chatPost(mock.url, [
      { role: "user", content: "weather" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_w1",
            type: "function",
            function: { name: "get_weather", arguments: '{"city":"NYC"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_w1", content: '{"temp":72,"condition":"sunny"}' },
    ]);
    expect(res1.status).toBe(200);
    const body1 = (await res1.json()) as { choices: { message: { content: string } }[] };
    expect(body1.choices[0].message.content).toBe("The weather in NYC is sunny, 72F.");
  });
});

describe("hasToolResult — concurrency", () => {
  let mock: LLMock;

  beforeAll(async () => {
    mock = new LLMock();
    await mock.start();
  });

  afterAll(async () => {
    await mock.stop();
  });

  it("5 no-tool + 5 with-tool concurrent requests all discriminate correctly", async () => {
    mock.reset();
    mock.on(
      { userMessage: "concurrent-tool", hasToolResult: false },
      { content: "no-tool-response" },
    );
    mock.on(
      { userMessage: "concurrent-tool", hasToolResult: true },
      { content: "has-tool-response" },
    );

    const noToolMessages = [{ role: "user", content: "concurrent-tool" }];
    const withToolMessages = [
      { role: "user", content: "concurrent-tool" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_ct1",
            type: "function",
            function: { name: "some_tool", arguments: "{}" },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_ct1", content: "result" },
    ];

    const allPromises = [
      ...Array.from({ length: 5 }, () => chatPost(mock.url, noToolMessages)),
      ...Array.from({ length: 5 }, () => chatPost(mock.url, withToolMessages)),
    ];

    const results = await Promise.all(allPromises);

    const noToolResults: string[] = [];
    const withToolResults: string[] = [];

    for (let i = 0; i < 10; i++) {
      expect(results[i].status).toBe(200);
      const body = (await results[i].json()) as {
        choices: { message: { content: string } }[];
      };
      if (i < 5) {
        noToolResults.push(body.choices[0].message.content);
      } else {
        withToolResults.push(body.choices[0].message.content);
      }
    }

    expect(noToolResults).toEqual(Array(5).fill("no-tool-response"));
    expect(withToolResults).toEqual(Array(5).fill("has-tool-response"));
  });
});

// ---------------------------------------------------------------------------
// 3. Combined turnIndex + hasToolResult (AND logic)
// ---------------------------------------------------------------------------

describe("combined turnIndex + hasToolResult — AND logic", () => {
  let mock: LLMock;

  beforeAll(async () => {
    mock = new LLMock();
    await mock.start();
  });

  afterAll(async () => {
    await mock.stop();
  });

  it("both conditions must hold for the specific fixture to match", async () => {
    mock.reset();
    // Specific: turnIndex 1 AND hasToolResult true → specific response
    mock.on(
      { userMessage: "combined", turnIndex: 1, hasToolResult: true },
      { content: "combined-specific" },
    );
    // Fallback: just userMessage → matches anything else
    mock.on({ userMessage: "combined" }, { content: "combined-fallback" });

    // Request with turnIndex=1 but NO tool result → AND fails → fallback
    const res0 = await chatPost(mock.url, [
      { role: "user", content: "combined" },
      { role: "assistant", content: "something" },
    ]);
    expect(res0.status).toBe(200);
    const body0 = (await res0.json()) as { choices: { message: { content: string } }[] };
    expect(body0.choices[0].message.content).toBe("combined-fallback");

    // Request with turnIndex=0 and hasToolResult=true → AND fails (turnIndex wrong) → fallback
    const res1 = await chatPost(mock.url, [
      { role: "user", content: "combined" },
      { role: "tool", tool_call_id: "call_1", content: "result" },
    ]);
    expect(res1.status).toBe(200);
    const body1 = (await res1.json()) as { choices: { message: { content: string } }[] };
    expect(body1.choices[0].message.content).toBe("combined-fallback");

    // Request with turnIndex=1 AND hasToolResult=true → both pass → specific
    const res2 = await chatPost(mock.url, [
      { role: "user", content: "combined" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_c1",
            type: "function",
            function: { name: "do_thing", arguments: "{}" },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_c1", content: "done" },
    ]);
    expect(res2.status).toBe(200);
    const body2 = (await res2.json()) as { choices: { message: { content: string } }[] };
    expect(body2.choices[0].message.content).toBe("combined-specific");
  });
});

// ---------------------------------------------------------------------------
// 4. JSON fixture loading
// ---------------------------------------------------------------------------

describe("turnIndex and hasToolResult via JSON fixtures", () => {
  let mock: LLMock;

  beforeAll(async () => {
    mock = new LLMock();
    await mock.start();
  });

  afterAll(async () => {
    await mock.stop();
  });

  it("addFixturesFromJSON loads turnIndex and hasToolResult correctly", async () => {
    mock.reset();
    mock.addFixturesFromJSON([
      {
        match: { userMessage: "json-turn", turnIndex: 0, hasToolResult: false },
        response: {
          toolCalls: [{ name: "json_tool", arguments: '{"key":"val"}', id: "call_jt1" }],
        },
      },
      {
        match: { userMessage: "json-turn", turnIndex: 1, hasToolResult: true },
        response: { content: "json-turn-1-with-tool" },
      },
    ]);

    // Turn 0, no tool result → matches first fixture
    const res0 = await chatPost(mock.url, [{ role: "user", content: "json-turn" }]);
    expect(res0.status).toBe(200);
    const body0 = (await res0.json()) as {
      choices: { message: { tool_calls: { function: { name: string } }[] } }[];
    };
    expect(body0.choices[0].message.tool_calls[0].function.name).toBe("json_tool");

    // Turn 1, with tool result → matches second fixture
    const res1 = await chatPost(mock.url, [
      { role: "user", content: "json-turn" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_jt1",
            type: "function",
            function: { name: "json_tool", arguments: '{"key":"val"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_jt1", content: '{"result":"ok"}' },
    ]);
    expect(res1.status).toBe(200);
    const body1 = (await res1.json()) as { choices: { message: { content: string } }[] };
    expect(body1.choices[0].message.content).toBe("json-turn-1-with-tool");
  });
});

// ---------------------------------------------------------------------------
// 5. turnIndex with onTurn convenience method
// ---------------------------------------------------------------------------

describe("onTurn convenience method", () => {
  let mock: LLMock;

  beforeAll(async () => {
    mock = new LLMock();
    await mock.start();
  });

  afterAll(async () => {
    await mock.stop();
  });

  it("onTurn(n, pattern, response) sets turnIndex correctly", async () => {
    mock.reset();
    mock.onTurn(0, "convenient", { content: "on-turn-0" });
    mock.onTurn(1, "convenient", { content: "on-turn-1" });

    // Turn 0
    const res0 = await chatPost(mock.url, [{ role: "user", content: "convenient" }]);
    expect(res0.status).toBe(200);
    const body0 = (await res0.json()) as { choices: { message: { content: string } }[] };
    expect(body0.choices[0].message.content).toBe("on-turn-0");

    // Turn 1
    const res1 = await chatPost(mock.url, [
      { role: "user", content: "convenient" },
      { role: "assistant", content: "on-turn-0" },
    ]);
    expect(res1.status).toBe(200);
    const body1 = (await res1.json()) as { choices: { message: { content: string } }[] };
    expect(body1.choices[0].message.content).toBe("on-turn-1");
  });
});

// ---------------------------------------------------------------------------
// 6. turnIndex does NOT interfere with sequenceIndex
// ---------------------------------------------------------------------------

describe("turnIndex independence from sequenceIndex", () => {
  let mock: LLMock;

  beforeAll(async () => {
    mock = new LLMock();
    await mock.start();
  });

  afterAll(async () => {
    await mock.stop();
  });

  it("turnIndex is stateless; same request always matches the same turnIndex fixture", async () => {
    mock.reset();
    mock.on({ userMessage: "no-drift", turnIndex: 0 }, { content: "always-zero" });

    // Send the same request 3 times — turnIndex is determined by message
    // content (assistant count = 0), so it always matches turnIndex 0
    for (let i = 0; i < 3; i++) {
      const res = await chatPost(mock.url, [{ role: "user", content: "no-drift" }]);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { choices: { message: { content: string } }[] };
      expect(body.choices[0].message.content).toBe("always-zero");
    }
  });
});

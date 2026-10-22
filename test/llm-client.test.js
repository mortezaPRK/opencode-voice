import assert from "node:assert/strict";
import test from "node:test";

import { createClient } from "../dist/lib/llm-client.js";

function createJsonResponse(status, data) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return data;
    },
  };
}

test("returns error when endpoint is not configured", async () => {
  const client = createClient({ model: "test-model" });
  const result = await client.complete({ prompt: "Test" });

  assert.deepEqual(result, {
    text: null,
    error: "LLM endpoint not configured",
  });
});

test("returns error when model is not configured", async () => {
  const client = createClient({ endpoint: "https://example.test/v1" });
  const result = await client.complete({ prompt: "Test" });

  assert.deepEqual(result, {
    text: null,
    error: "LLM model not configured",
  });
});

test("sends chat completions requests with reasoning_effort when configured", async () => {
  const previousKey = process.env.TEST_LLM_API_KEY;
  const previousFetch = globalThis.fetch;
  const requests = [];
  process.env.TEST_LLM_API_KEY = "secret";

  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return createJsonResponse(200, {
      choices: [{ message: { content: "normalized text" } }],
    });
  };

  try {
    const client = createClient({
      endpoint: "https://example.test/v1/",
      model: "gpt-test",
      apiKeyEnv: "TEST_LLM_API_KEY",
      maxTokens: 321,
      reasoningEffort: "low",
      retries: 0,
    });

    const result = await client.complete({
      system: "System prompt",
      prompt: "User prompt",
    });

    assert.equal(result.text, "normalized text");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "https://example.test/v1/chat/completions");
    assert.equal(requests[0].options.method, "POST");
    assert.deepEqual(JSON.parse(requests[0].options.body), {
      model: "gpt-test",
      max_tokens: 321,
      reasoning_effort: "low",
      messages: [
        { role: "system", content: "System prompt" },
        { role: "user", content: "User prompt" },
      ],
    });
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) {
      delete process.env.TEST_LLM_API_KEY;
    } else {
      process.env.TEST_LLM_API_KEY = previousKey;
    }
  }
});

test("sends chat_template_kwargs when configured", async () => {
  const previousKey = process.env.TEST_LLM_API_KEY;
  const previousFetch = globalThis.fetch;
  const requests = [];
  process.env.TEST_LLM_API_KEY = "secret";

  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return createJsonResponse(200, {
      choices: [{ message: { content: "text" } }],
    });
  };

  try {
    const client = createClient({
      endpoint: "https://example.test/v1",
      model: "qwen-test",
      apiKeyEnv: "TEST_LLM_API_KEY",
      chatTemplateKwargs: { enable_thinking: false },
      retries: 0,
    });

    const result = await client.complete({ prompt: "Test" });
    assert.equal(result.text, "text");
    const body = JSON.parse(requests[0].options.body);
    assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false });
    assert.equal(body.reasoning_effort, undefined);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) {
      delete process.env.TEST_LLM_API_KEY;
    } else {
      process.env.TEST_LLM_API_KEY = previousKey;
    }
  }
});

test("does not send chat_template_kwargs when not configured", async () => {
  const previousKey = process.env.TEST_LLM_API_KEY;
  const previousFetch = globalThis.fetch;
  const requests = [];
  process.env.TEST_LLM_API_KEY = "secret";

  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return createJsonResponse(200, {
      choices: [{ message: { content: "text" } }],
    });
  };

  try {
    const client = createClient({
      endpoint: "https://example.test/v1",
      model: "test-model",
      apiKeyEnv: "TEST_LLM_API_KEY",
      retries: 0,
    });

    const result = await client.complete({ prompt: "Test" });
    assert.equal(result.text, "text");
    const body = JSON.parse(requests[0].options.body);
    assert.equal(body.chat_template_kwargs, undefined);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) {
      delete process.env.TEST_LLM_API_KEY;
    } else {
      process.env.TEST_LLM_API_KEY = previousKey;
    }
  }
});

test("sends requests without Authorization header when no apiKeyEnv", async () => {
  const previousFetch = globalThis.fetch;
  const requests = [];

  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return createJsonResponse(200, {
      choices: [{ message: { content: "text" } }],
    });
  };

  try {
    const client = createClient({
      endpoint: "https://example.test/v1",
      model: "test-model",
      retries: 0,
    });

    const result = await client.complete({ prompt: "Test" });
    assert.equal(result.text, "text");
    assert.equal(requests[0].options.headers.Authorization, undefined);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("returns error when LLM fails after retries", async () => {
  const previousKey = process.env.TEST_LLM_API_KEY;
  const previousFetch = globalThis.fetch;
  const previousSetTimeout = globalThis.setTimeout;
  process.env.TEST_LLM_API_KEY = "secret";

  globalThis.fetch = async () => {
    return createJsonResponse(500, { error: "internal error" });
  };

  globalThis.setTimeout = (fn) => {
    fn();
    return 0;
  };

  try {
    const client = createClient({
      endpoint: "https://example.test/v1",
      model: "test-model",
      apiKeyEnv: "TEST_LLM_API_KEY",
      retries: 1,
    });

    const result = await client.complete({ prompt: "Test" });

    assert.equal(result.text, null);
    assert.match(result.error, /LLM request failed/);
  } finally {
    globalThis.fetch = previousFetch;
    globalThis.setTimeout = previousSetTimeout;
    if (previousKey === undefined) {
      delete process.env.TEST_LLM_API_KEY;
    } else {
      process.env.TEST_LLM_API_KEY = previousKey;
    }
  }
});

test("retries transient failures and eventually returns the response text", async () => {
  const previousKey = process.env.TEST_LLM_API_KEY;
  const previousFetch = globalThis.fetch;
  const previousSetTimeout = globalThis.setTimeout;
  let attempts = 0;
  process.env.TEST_LLM_API_KEY = "secret";

  globalThis.fetch = async () => {
    attempts += 1;
    if (attempts < 3) {
      return createJsonResponse(429, { error: { message: "rate limited" } });
    }
    return createJsonResponse(200, {
      choices: [{ message: { content: "recovered text" } }],
    });
  };

  globalThis.setTimeout = (fn) => {
    fn();
    return 0;
  };

  try {
    const client = createClient({
      endpoint: "https://example.test/v1",
      model: "test-model",
      apiKeyEnv: "TEST_LLM_API_KEY",
      retries: 2,
    });

    const result = await client.complete({ prompt: "Retry this" });

    assert.deepEqual(result, { text: "recovered text" });
    assert.equal(attempts, 3);
  } finally {
    globalThis.fetch = previousFetch;
    globalThis.setTimeout = previousSetTimeout;
    if (previousKey === undefined) {
      delete process.env.TEST_LLM_API_KEY;
    } else {
      process.env.TEST_LLM_API_KEY = previousKey;
    }
  }
});

// ---- OpenCode backend ----

test("uses the opencode backend with an explicit model and combined prompt", async () => {
  const calls = [];
  const client = createClient(
    {
      llm: {
        type: "opencode",
        model: { providerID: "anthropic", id: "claude-sonnet-4-6" },
      },
    },
    undefined,
    async (request) => {
      calls.push(request);
      return { text: "  normalized text  " };
    },
  );

  const result = await client.complete({ system: "System prompt", prompt: "User prompt" });

  assert.deepEqual(result, { text: "normalized text" });
  assert.equal(client.backend, "opencode");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].prompt, "System prompt\n\n---\n\nUser prompt");
  assert.deepEqual(calls[0].model, { providerID: "anthropic", id: "claude-sonnet-4-6" });
  assert.ok(calls[0].signal instanceof AbortSignal);
});

test("uses the OpenCode default model when llm.model is omitted", async () => {
  const calls = [];
  const client = createClient({ llm: { type: "opencode" } }, undefined, async (request) => {
    calls.push(request);
    return { text: "ok" };
  });

  const result = await client.complete({ prompt: "Test" });

  assert.equal(result.text, "ok");
  assert.equal(calls[0].model, null);
});

test("does not fall back to the OpenAI-compatible endpoint when opencode fails", async () => {
  const previousFetch = globalThis.fetch;
  let fetched = false;
  globalThis.fetch = async () => {
    fetched = true;
    return createJsonResponse(200, { choices: [{ message: { content: "unexpected" } }] });
  };

  try {
    const client = createClient(
      {
        endpoint: "https://example.test/v1",
        model: "legacy-model",
        llm: { type: "opencode" },
      },
      undefined,
      async () => {
        throw new Error("provider unavailable");
      },
    );

    const result = await client.complete({ prompt: "Test" });

    assert.deepEqual(result, { text: null, error: "LLM error: provider unavailable" });
    assert.equal(fetched, false);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("reports empty OpenCode responses as errors", async () => {
  const client = createClient({ llm: { type: "opencode" } }, undefined, async () => ({
    text: "   ",
  }));

  const result = await client.complete({ prompt: "Test" });

  assert.deepEqual(result, { text: null, error: "Empty LLM response" });
});

test("reports OpenCode timeouts with an actionable message", async () => {
  const client = createClient(
    { llm: { type: "opencode", timeoutMs: 5 } },
    undefined,
    ({ signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () =>
          reject(Object.assign(new Error("aborted"), { name: "TimeoutError" })),
        );
      }),
  );

  const result = await client.complete({ prompt: "Test" });

  assert.equal(result.text, null);
  assert.equal(result.error, "LLM request timed out (5ms)");
});

test("rejects settings the opencode backend cannot apply", async () => {
  const client = createClient({
    llm: {
      type: "opencode",
      endpoint: "https://example.test/v1",
      maxTokens: 100,
      reasoningEffort: "low",
    },
  });

  const result = await client.complete({ prompt: "Test" });

  assert.equal(result.text, null);
  assert.match(result.error, /does not support: endpoint, maxTokens, reasoningEffort/);
  assert.match(result.error, /OpenCode applies model settings itself/);
});

test("rejects an opencode model that is not a provider/model ref", async () => {
  const client = createClient({ llm: { type: "opencode", model: "claude-haiku-4-5" } });

  const result = await client.complete({ prompt: "Test" });

  assert.equal(result.text, null);
  assert.match(result.error, /llm\.model must be an object/);
});

test("rejects an unknown llm.type", async () => {
  const client = createClient({ llm: { type: "anthropic" } });

  const result = await client.complete({ prompt: "Test" });

  assert.equal(result.text, null);
  assert.match(result.error, /Unknown llm\.type "anthropic"/);
});

test("warns when top-level LLM options are ignored by an explicit backend", async () => {
  const warnings = [];
  const logger = { log: (_scope, message, level) => warnings.push({ message, level }) };

  createClient(
    {
      endpoint: "https://example.test/v1",
      model: "legacy-model",
      llm: { type: "opencode" },
    },
    logger,
    async () => ({ text: "ok" }),
  );

  assert.ok(
    warnings.some(
      (entry) =>
        entry.level === "warn" &&
        entry.message.includes("Ignoring top-level LLM options (endpoint, model)"),
    ),
  );
});

// ---- Explicit OpenAI-compatible backend ----

test("supports llm.type openai-compatible with nested settings", async () => {
  const previousFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return createJsonResponse(200, {
      choices: [{ message: { content: "direct text" } }],
    });
  };

  try {
    const client = createClient({
      endpoint: "https://legacy.test/v1",
      model: "legacy-model",
      llm: {
        type: "openai-compatible",
        endpoint: "https://example.test/v1/",
        model: "gpt-test",
        maxTokens: 128,
        retries: 0,
      },
    });

    const result = await client.complete({ prompt: "Test" });

    assert.equal(client.backend, "openai-compatible");
    assert.equal(result.text, "direct text");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "https://example.test/v1/chat/completions");
    const body = JSON.parse(requests[0].options.body);
    assert.equal(body.model, "gpt-test");
    assert.equal(body.max_tokens, 128);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("requires endpoint and model for llm.type openai-compatible", async () => {
  const missingEndpoint = createClient({
    llm: { type: "openai-compatible", model: "gpt-test" },
  });
  assert.match(
    (await missingEndpoint.complete({ prompt: "Test" })).error,
    /llm\.endpoint is required/,
  );

  const missingModel = createClient({
    llm: { type: "openai-compatible", endpoint: "https://example.test/v1" },
  });
  assert.match((await missingModel.complete({ prompt: "Test" })).error, /llm\.model is required/);
});

test("rejects unsupported keys under llm.type openai-compatible", async () => {
  const client = createClient({
    llm: {
      type: "openai-compatible",
      endpoint: "https://example.test/v1",
      model: "gpt-test",
      timeoutMs: 1000,
    },
  });

  const result = await client.complete({ prompt: "Test" });

  assert.equal(result.text, null);
  assert.match(result.error, /does not support: timeoutMs/);
});

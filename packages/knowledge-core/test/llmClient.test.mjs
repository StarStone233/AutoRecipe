import assert from "node:assert/strict";
import test from "node:test";

test("classifyPage returns defaults on API failure", async () => {
  const { createLLMClient } = await import("../dist/llmClient.js");
  const client = createLLMClient({ apiKey: "test-invalid-key", timeoutMs: 1000, maxRetries: 0 });
  const result = await client.classifyPage(undefined, ["Login", "Username", "Password"], "https://example.com/login");
  assert.equal(result.page_type, "other");
  assert.equal(result.confidence, 0);
});

test("annotateModule returns defaults on API failure", async () => {
  const { createLLMClient } = await import("../dist/llmClient.js");
  const client = createLLMClient({ apiKey: "test-invalid-key", timeoutMs: 1000, maxRetries: 0 });
  const result = await client.annotateModule("Orders", ["create", "list"], ["list", "form"], "left_nav");
  assert.equal(result.business_purpose, "");
  assert.deepEqual(result.data_entities, []);
  assert.equal(result.confidence, 0);
});

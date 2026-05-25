import assert from "node:assert/strict";
import test from "node:test";

test("enrichWithSemanticData skips when no API key", async () => {
  const { enrichWithSemanticData } = await import("../dist/semanticEnrichment.js");
  const result = await enrichWithSemanticData(undefined, {
    pageMap: { pages: [], navigation_edges: [], generated_at: "", schema_version: "v1", producer: "test", artifact_type: "page_map", source_system: "test", source_url: "" },
    businessCatalog: { modules: [], navigation_edges: [], generated_at: "", schema_version: "v1", producer: "test", artifact_type: "business_catalog", source_system: "test", source_url: "" },
    pageScreenshots: new Map(),
  });
  assert.equal(result.pageClassifications.size, 0);
  assert.equal(result.moduleAnnotations.length, 0);
});

test("applyEnrichmentToArtifacts sets page_type and annotations", async () => {
  const { applyEnrichmentToArtifacts } = await import("../dist/semanticEnrichment.js");

  const pageMap = {
    pages: [{ page_id: "p1", page_url: "https://example.com/orders", page_type: "other", page_description: "", heat_zones: [] }],
    navigation_edges: [],
    generated_at: "", schema_version: "v1", producer: "test", artifact_type: "page_map", source_system: "test", source_url: "",
  };
  const semanticAnnotations = {
    annotations: [],
    generated_at: "", schema_version: "v1", producer: "test", artifact_type: "semantic_annotations", system_key: "test", run_id: "test", model: "",
  };

  const enrichment = {
    pageClassifications: new Map([["p1", { page_type: "list", page_description: "Order list page", confidence: 0.85 }]]),
    moduleAnnotations: [{ module_id: "m1", business_purpose: "Manage orders", data_entities: ["order"], confidence: 0.8 }],
  };

  applyEnrichmentToArtifacts(enrichment, pageMap, semanticAnnotations);

  assert.equal(pageMap.pages[0].page_type, "list");
  assert.equal(pageMap.pages[0].page_description, "Order list page");
  assert.equal(semanticAnnotations.annotations.length, 1);
  assert.equal(semanticAnnotations.annotations[0].target_type, "module");
  assert.equal(semanticAnnotations.annotations[0].business_purpose, "Manage orders");
  assert.equal(semanticAnnotations.model, "deepseek-chat");
});

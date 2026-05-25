import type { LLMConfig, PageClassification, ModuleAnnotation } from "./llmClient.js";
import { createLLMClient } from "./llmClient.js";
import type { PageMapArtifact, BusinessCatalogArtifact, SemanticAnnotationsArtifact } from "./schemas.js";

export interface EnrichmentInput {
  pageMap: PageMapArtifact;
  businessCatalog: BusinessCatalogArtifact;
  pageScreenshots: Map<string, string[]>;
  readFileAsBase64?: (path: string) => Promise<string | undefined>;
}

export interface EnrichmentResult {
  pageClassifications: Map<string, PageClassification>;
  moduleAnnotations: Array<{ module_id: string } & ModuleAnnotation>;
}

export async function enrichWithSemanticData(
  config: LLMConfig | undefined,
  input: EnrichmentInput,
): Promise<EnrichmentResult> {
  const result: EnrichmentResult = {
    pageClassifications: new Map(),
    moduleAnnotations: [],
  };

  if (!config?.apiKey) {
    console.warn("[semantic-enrichment] no API key configured, skipping");
    return result;
  }

  const client = createLLMClient(config);

  const pageInputs: Array<{
    page_id: string;
    page_url: string;
    screenshotBase64?: string;
    elementTexts: string[];
  }> = [];

  for (const page of input.pageMap.pages.slice(0, 12)) {
    const screenshotPaths = input.pageScreenshots.get(page.page_url) || [];
    let screenshotBase64: string | undefined;
    if (screenshotPaths.length > 0 && input.readFileAsBase64) {
      screenshotBase64 = await input.readFileAsBase64(screenshotPaths[0]);
    }
    const elementTexts = page.heat_zones.flatMap((z) => z.top_labels);
    pageInputs.push({
      page_id: page.page_id,
      page_url: page.page_url,
      screenshotBase64,
      elementTexts,
    });
  }

  if (pageInputs.length) {
    try {
      result.pageClassifications = await client.classifyPagesBatch(pageInputs);
    } catch (error) {
      console.warn("[semantic-enrichment] batch page classification failed, falling back to per-page:", error);
      for (const page of input.pageMap.pages.slice(0, 12)) {
        try {
          const classification = await client.classifyPage(
            pageInputs.find((p) => p.page_id === page.page_id)?.screenshotBase64,
            pageInputs.find((p) => p.page_id === page.page_id)?.elementTexts || [],
            page.page_url,
          );
          result.pageClassifications.set(page.page_id, classification);
        } catch (innerError) {
          console.warn(`[semantic-enrichment] page classification failed for ${page.page_url}:`, innerError);
        }
      }
    }
  }

  const moduleInputs: Array<{
    module_id: string;
    title: string;
    actions: string[];
    pageTypes: string[];
    region: string;
  }> = [];

  for (const mod of input.businessCatalog.modules.slice(0, 10)) {
    const actionLabels = mod.actions.map((a) => a.label);
    const modulePageTypes = mod.pages
      .map((pid) => result.pageClassifications.get(pid)?.page_type || "other")
      .filter((t) => t !== "other");
    const uniquePageTypes = [...new Set(modulePageTypes)];
    moduleInputs.push({
      module_id: mod.module_id,
      title: mod.title,
      actions: actionLabels,
      pageTypes: uniquePageTypes,
      region: mod.source_region,
    });
  }

  if (moduleInputs.length) {
    try {
      result.moduleAnnotations = await client.annotateModulesBatch(moduleInputs);
    } catch (error) {
      console.warn("[semantic-enrichment] batch module annotation failed, falling back to per-module:", error);
      for (const mod of input.businessCatalog.modules.slice(0, 10)) {
        try {
          const input = moduleInputs.find((m) => m.module_id === mod.module_id);
          if (!input) continue;
          const annotation = await client.annotateModule(input.title, input.actions, input.pageTypes, input.region);
          result.moduleAnnotations.push({ module_id: mod.module_id, ...annotation });
        } catch (innerError) {
          console.warn(`[semantic-enrichment] module annotation failed for ${mod.module_id}:`, innerError);
        }
      }
    }
  }

  return result;
}

export function applyEnrichmentToArtifacts(
  enrichment: EnrichmentResult,
  pageMap: PageMapArtifact,
  semanticAnnotations: SemanticAnnotationsArtifact,
): void {
  for (const page of pageMap.pages) {
    const classification = enrichment.pageClassifications.get(page.page_id);
    if (classification) {
      page.page_type = classification.page_type;
      page.page_description = classification.page_description;
    }
  }

  for (const annotation of enrichment.moduleAnnotations) {
    if (!annotation.business_purpose && annotation.data_entities.length === 0) continue;
    semanticAnnotations.annotations.push({
      target_type: "module",
      target_id: annotation.module_id,
      business_purpose: annotation.business_purpose,
      data_entities: annotation.data_entities,
      model: "deepseek-chat",
      confidence: annotation.confidence,
      evidence_refs: [],
    });
  }

  if (enrichment.moduleAnnotations.length > 0) {
    semanticAnnotations.model = "deepseek-chat";
  }
}

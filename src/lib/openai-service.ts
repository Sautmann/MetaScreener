"use client";

import { AIOptions, CustomField, Paper } from "@/types";
import OpenAI from "openai";

// Import prompt files
import basePrompt from "@/components/prompts/base-prompt.md?raw";
import designPrompt from "@/components/prompts/design-prompt.md?raw";
import flagsPrompt from "@/components/prompts/flags-prompt.md?raw";
import methodPrompt from "@/components/prompts/method-prompt.md?raw";
import { downloadFile } from "./utils";

// Function to get OpenAI client with API key from localStorage
let openAIClient: OpenAI | null = null;
let openAIClientKey: string | null = null;
const isDryRun = false

function getOpenAIClient(): OpenAI {
  const apiKey = localStorage.getItem('openai_api_key');
  if (!apiKey) {
    throw new Error('OpenAI API key not found. Please set it in Settings.');
  }

  // Recreate the client if the stored key changed (e.g. after saving Settings)
  if (openAIClient && openAIClientKey === apiKey) return openAIClient;

  openAIClient = new OpenAI({
    apiKey: apiKey,
    dangerouslyAllowBrowser: true,
  });
  openAIClientKey = apiKey;

  return openAIClient;
}

/** Call after saving a new API key so subsequent requests use it. */
export function resetOpenAIClient(): void {
  openAIClient = null;
  openAIClientKey = null;
}

// Cache helper for models list
type ModelsCache = { models: string[]; cachedAt: number };

// Bump the key when filter logic changes so stale lists are discarded
const MODELS_CACHE_KEY = "openai_models_cache_v2";
const MODELS_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

export function clearModelsCache(): void {
  localStorage.removeItem(MODELS_CACHE_KEY);
  // Also drop the pre-v2 cache key if present
  localStorage.removeItem("openai_models_cache");
}

// Fallback if the API is unreachable and nothing is cached
const FALLBACK_MODELS = [
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5",
  "gpt-5-mini",
  "gpt-5-nano",
  "gpt-4.1",
  "gpt-4.1-mini",
];

// Specialty / non-chat model id fragments to hide from the screening picker
const EXCLUDED_MODEL_PATTERNS = [
  "audio",
  "realtime",
  "search",
  "transcribe",
  "tts",
  "image",
  "instruct",
  "embedding",
  "moderation",
  "dall-e",
  "whisper",
  "davinci",
  "babbage",
  "codex",
  "computer-use",
  "deep-research",
];

function isChatCompletionModel(id: string): boolean {
  const lower = id.toLowerCase();
  // Chat-capable families: GPT*, ChatGPT aliases, and o-series reasoning models
  const isChatFamily =
    lower.startsWith("gpt-") ||
    lower.startsWith("chatgpt-") ||
    /^o\d/.test(lower);
  if (!isChatFamily) return false;
  // Fine-tunes use "ft:..." — skip those for the screening picker
  if (lower.startsWith("ft:")) return false;
  if (EXCLUDED_MODEL_PATTERNS.some((pattern) => lower.includes(pattern))) return false;
  // Hide dated snapshots (e.g. gpt-4o-2024-08-06, gpt-5-2025-08-07);
  // undated aliases / tier names (gpt-5.6-sol) point at the same models
  if (/-\d{4}-\d{2}-\d{2}$/.test(lower)) return false;
  if (/-\d{4}$/.test(lower)) return false; // e.g. gpt-4-0613
  return true;
}

function readModelsCache(): ModelsCache | null {
  try {
    const raw = localStorage.getItem(MODELS_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ModelsCache;
    if (!Array.isArray(parsed.models) || parsed.models.length === 0) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function listAvailableModels(forceRefresh: boolean = false): Promise<string[]> {
  const cached = readModelsCache();
  if (!forceRefresh && cached && Date.now() - cached.cachedAt < MODELS_CACHE_TTL_MS) {
    return cached.models;
  }

  if (forceRefresh) {
    clearModelsCache();
  }

  try {
    const openai = getOpenAIClient();
    const models: Array<{ id: string; created?: number }> = [];
    // Paginate via async iterator (SDK may return everything in one page today)
    for await (const model of openai.models.list()) {
      models.push(model);
    }

    const chatModels = models
      .filter((m) => isChatCompletionModel(m.id))
      .sort((a, b) => {
        const createdDiff = (b.created ?? 0) - (a.created ?? 0);
        if (createdDiff !== 0) return createdDiff;
        return a.id.localeCompare(b.id);
      })
      .map((m) => m.id);

    if (chatModels.length > 0) {
      const cache: ModelsCache = { models: chatModels, cachedAt: Date.now() };
      localStorage.setItem(MODELS_CACHE_KEY, JSON.stringify(cache));
      return chatModels;
    }

    console.warn(
      "OpenAI models.list returned no chat-capable models after filtering.",
      `Raw count: ${models.length}. Sample:`,
      models.slice(0, 20).map((m) => m.id)
    );
    return cached?.models ?? FALLBACK_MODELS;
  } catch (error) {
    // A stale cache is better than no models at all
    if (cached) {
      console.warn("Failed to refresh models from OpenAI, using cached list:", error);
      return cached.models;
    }
    console.error("Failed to fetch available models:", error);
    throw error;
  }
}

export async function cancelBatch(batchId?: string): Promise<void> {
  if (!batchId) {
    throw new Error("Batch ID is required to cancel the batch.");
  }
  const openai = getOpenAIClient();
  try {
    await openai.batches.cancel(batchId);
  } catch (error) {
    console.error("Failed to cancel batch:", error);
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    if (errorMessage.includes("not found") || errorMessage.includes("404")) {
      throw new Error("Batch not found. It may have already been completed or deleted.");
    } else if (errorMessage.includes("already") || errorMessage.includes("completed")) {
      throw new Error("Batch has already been completed and cannot be cancelled.");
    } else if (errorMessage.includes("network") || errorMessage.includes("fetch")) {
      throw new Error("Network error: Unable to connect to OpenAI. Please check your internet connection.");
    } else {
      throw new Error(`Failed to cancel batch: ${errorMessage}`);
    }
  }
}
export const DEFAULT_TEMPERATURE = 0.6;
export const DEFAULT_MAX_COMPLETION_TOKENS = 1500;

function resolveTemperature(options?: AIOptions): number {
  const value = options?.temperature;
  if (value == null || !Number.isFinite(value) || value < 0 || value > 2) {
    return DEFAULT_TEMPERATURE;
  }
  return value;
}

function resolveMaxCompletionTokens(options?: AIOptions): number {
  const value = options?.max_completion_tokens;
  if (value == null || !Number.isFinite(value) || value < 1) {
    return DEFAULT_MAX_COMPLETION_TOKENS;
  }
  return Math.floor(value);
}

const getAIOptions = (options?: AIOptions) => {
  const model = options?.model || "gpt-4.1";
  const isGpt5 = model.toLowerCase().startsWith("gpt-5");
  const isGpt41 = model.toLowerCase().startsWith("gpt-4.1");
  const enableLogprobs = localStorage.getItem('enable_logprobs') === 'true';
  const temperature = resolveTemperature(options);
  const max_completion_tokens = resolveMaxCompletionTokens(options);
  
  // GPT-5 models have stricter parameter requirements and don't support logprobs
  if (isGpt5) {
    return {
      model,
      // GPT-5 doesn't support logprobs - never include them
    };
  }
  
  // GPT-4.1 models - automatically enable logprobs if setting is enabled
  if (isGpt41 && enableLogprobs) {
    return {
      model,
      logprobs: true,
      top_logprobs: 4,
      temperature,
      max_completion_tokens,
      top_p: 1,
      frequency_penalty: 0,
      presence_penalty: 0,
    };
  }
  
  // Other models or logprobs disabled - default behavior without logprobs
  return {
    model,
    temperature,
    max_completion_tokens,
    top_p: 1,
    frequency_penalty: 0,
    presence_penalty: 0,
  };
}
export async function createBatch(
  papers: Paper[],
  fields: {
    design: boolean;
    method: boolean;
    custom: Array<CustomField>;
  },
  options: AIOptions = {}
) {
  try {
    const openai = getOpenAIClient();
    const systemPrompt = options.systemPromptOverride?.trim()?.length ? options.systemPromptOverride! : createSystemPrompt(fields);
    const aiOptions = getAIOptions(options);
    const requests = papers.map((paper) => {
      const userPrompt = createUserPrompt(paper);
      return {
        custom_id: `request-${paper.id}`,
        method: "POST",
        url: "/v1/chat/completions",
        body: {
          messages: [
            {
              role: "system",
              content: systemPrompt,
            },
            {
              role: "user",
              content: userPrompt,
            },
          ],
          response_format: { type: "json_object" },
          ...aiOptions
        },
      };
    });
    const jsonl = requests.map((req) => JSON.stringify(req)).join("\n");
    const safeModel = (aiOptions.model || "model").replace(/[^a-z0-9._-]/gi, "_");
    
    // Download JSONL if requested
    if (options.downloadJsonl) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
      downloadFile(`batch_${safeModel}_${timestamp}.jsonl`, jsonl, "application/jsonl");
    }
    
    if (isDryRun) {
      console.log("Dry run mode: Batch creation skipped.");
      downloadFile(`batch_${safeModel}.jsonl`, jsonl, "application/jsonl");
      return "dry-run-batch-id";
    }
    
    const file = await openai.files.create({
      file: new File([jsonl], `batch_${safeModel}.jsonl`, { type: "application/jsonl" }),
      purpose: "batch",
    });

    const batch = await openai.batches.create({
      input_file_id: file.id,
      endpoint: "/v1/chat/completions",
      completion_window: "24h",
    });

    return batch.id;
  } catch (error) {
    console.error("Failed to create batch:", error);
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    if (errorMessage.includes("API key")) {
      throw new Error("OpenAI API key not configured or invalid. Please check Settings.");
    } else if (errorMessage.includes("quota") || errorMessage.includes("rate limit") || errorMessage.includes("insufficient")) {
      throw new Error("OpenAI API quota exceeded or rate limit reached. Please check your OpenAI account or try again later.");
    } else if (errorMessage.includes("model") && errorMessage.includes("not found")) {
      throw new Error(`Selected model is not available. Please choose a different model.`);
    } else if (errorMessage.includes("network") || errorMessage.includes("fetch") || errorMessage.includes("ECONNREFUSED")) {
      throw new Error("Network error: Unable to connect to OpenAI. Please check your internet connection.");
    } else {
      throw new Error(`Failed to create batch: ${errorMessage}`);
    }
  }
}

export async function getBatchStatus(batchId: string) {
  try {
    const openai = getOpenAIClient();
    const batch = await openai.batches.retrieve(batchId);
    return batch;
  } catch (error) {
    console.error("Failed to get batch status:", error);
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    if (errorMessage.includes("not found") || errorMessage.includes("404")) {
      throw new Error("Batch not found. It may have been deleted.");
    } else if (errorMessage.includes("API key")) {
      throw new Error("OpenAI API key not configured or invalid. Please check Settings.");
    } else if (errorMessage.includes("network") || errorMessage.includes("fetch")) {
      throw new Error("Network error: Unable to connect to OpenAI. Please check your internet connection.");
    } else {
      throw new Error(`Failed to get batch status: ${errorMessage}`);
    }
  }
}
export async function getBatchResults(batchId: string) {
  try {
    const openai = getOpenAIClient();
    const batch = await openai.batches.retrieve(batchId);
    // Allow downloading results if output_file_id exists, regardless of status
    // This enables downloading from expired/canceled batches that have partial results
    if (batch.output_file_id) {
      const file = await openai.files.content(batch.output_file_id);
      const results = await file.text();
      return results
        .split("\n")
        .filter(Boolean)
        .map((line: string) => JSON.parse(line));
    }
    return [];
  } catch (error) {
    console.error("Failed to get batch results:", error);
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    if (errorMessage.includes("not found") || errorMessage.includes("404")) {
      throw new Error("Batch not found or results no longer available.");
    } else if (errorMessage.includes("API key")) {
      throw new Error("OpenAI API key not configured or invalid. Please check Settings.");
    } else if (errorMessage.includes("JSON")) {
      throw new Error("Failed to parse batch results. The results file may be corrupted.");
    } else if (errorMessage.includes("network") || errorMessage.includes("fetch")) {
      throw new Error("Network error: Unable to connect to OpenAI. Please check your internet connection.");
    } else {
      throw new Error(`Failed to get batch results: ${errorMessage}`);
    }
  }
}

function createUserPrompt(paper: Paper): string {
  return `Paper Title: ${paper.title}\n\n` +
    `Paper Abstract: ${paper.abstract}\n\n` +
    `Paper Authors: ${paper.authors}\n\n` +
    `Paper Keywords: ${paper.keywords}\n\n` +
    `Paper DOI: ${paper.doi}\n\n` +
    `Paper Fulltext: ${paper.fulltext || "Fulltext not available"}\n\n`
}
export function createSystemPrompt(
  fields: {
    design: boolean;
    method: boolean;
    custom: Array<{ name: string; instruction: string; type?: "boolean" | "text" }>;
  }
): string {
  // Start with the base prompt
  let prompt = basePrompt + "\n\n";

  prompt += "Please extract the following fields from the paper in JSON format:\n";

  const keys = ["design", "method", "flags", "reasons_for_flags(short explanation if any flags are used)"];
  for (const field of fields.custom) {
    keys.push(nameToKey(field.name));
  }
  prompt += "\n" + designPrompt
  prompt += "\n\n" + methodPrompt;
  prompt += "\n\n" + flagsPrompt;

  if (fields.custom && fields.custom.length > 0) {
    const booleanFields = fields.custom.filter((f) => (f.type || "boolean") === "boolean");
    const textFields = fields.custom.filter((f) => (f.type || "boolean") === "text");

    if (booleanFields.length > 0) {
      prompt += "\n\n" + "For the following fields follow the instruction closely and provide a yes/no/maybe answer. An answer should be based on the content of the paper. If you are not sure output should be maybe\n";
      const fieldprompts = booleanFields.map((field) => {
        return `Field Key : ${nameToKey(field.name)} \nInstruction: ${field.instruction}`;
      });
      prompt += fieldprompts.join("\n\n");
    }

    if (textFields.length > 0) {
      prompt += "\n\n" + "For the following fields follow the instruction closely and provide a concise free-text answer based only on the paper content. Keep answers short and factual.\n";
      const textPrompts = textFields.map((field) => {
        return `Field Key : ${nameToKey(field.name)} \nInstruction: ${field.instruction}`;
      });
      prompt += textPrompts.join("\n\n");
    }
  }
  prompt += "\n\n" + "Output should be a JSON object with the following keys and nothing else:";
  prompt += "\n" + keys.map((key) => `- ${key}`).join("\n") + "\n\n";

  return prompt;
}

export function nameToKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, "_");
}
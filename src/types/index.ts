import OpenAI from "openai";
export interface Job {
  id: number;
  filename: string;
  mode: "fulltext" | "abstract";
  fields: {
    design: boolean;
    method: boolean;
    custom: Array<CustomField>;
  };
  status: OpenAI.Batch["status"];
  progress: number;
  total: number;
  created: Date;
  updated: Date;
  batchId?: string;
  batches?: Array<{ model: string; batchId: string; status?: string; completed?: number; failed?: number; total?: number; output_file_id?: string }>;
  pdfFiles?: FileList;
  options?: AIOptions;
  /** Why a synchronous job stopped (e.g. quota exhausted, invalid API key) */
  error?: string;
}

export interface AIOptions {
  model?: string;
  logprobs?: boolean;
  systemPromptOverride?: string;
  models?: string[];
  downloadJsonl?: boolean;
  temperature?: number;
  max_completion_tokens?: number;
  /** "row_index": request ids are the 1-based CSV row number. Older jobs may have used the CSV's own id column. */
  paperIdScheme?: "row_index";
  /** "batch" (default): OpenAI Batch API. "sync": direct Chat Completions calls from the browser. */
  processing?: "batch" | "sync";
  /** Parallel requests for synchronous jobs */
  concurrency?: number;
  /** Rate limits for synchronous jobs (requests / tokens per minute, per model) */
  rpmLimit?: number;
  tpmLimit?: number;
}

export interface CustomField{
  name: string;
  instruction: string;
  type?: "boolean" | "text";
  recheck_yes?: boolean;
  recheck_no?: boolean;
  force_recheck?: boolean;
}

export interface JobFile {
  id: number;
  jobId: number;
  filename: string;
  file: Blob
}

/** One request of a synchronous job, stored so the job can be resumed and exported */
export interface SyncTask {
  id?: number;
  jobId: number;
  model: string;
  customId: string;
  status: "pending" | "done" | "error";
  userPrompt: string;
  /** db.files id of the PDF sent with this request (full-text synchronous jobs) */
  pdfFileId?: number;
  pdfFilename?: string;
  /** Pages in the attached PDF (for the token estimate) */
  pdfPages?: number;
  /** Characters of extracted PDF text (for the token estimate) */
  pdfTextChars?: number;
  attempts?: number;
  /** Chat completion response body, same shape as a batch output line's response.body */
  response?: unknown;
  error?: string;
}

export interface ExtractedFields {
  [key: string]: string;
}

export interface Paper {
  id?: number;
  jobId?: number;
  title: string;
  abstract: string;
  authors: string;
  keywords: string;
  doi: string;
  fulltext?: string;
}

export interface PDFData {
    title?: string;
    authors?: string;
    year?: string;
    doi?: string;
    filename?: string;
    fulltext?: string;
    pages?: number;
}

export type PaperWithFields = Paper & Record<string, string>

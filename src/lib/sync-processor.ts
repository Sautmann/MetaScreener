import { Job, PaperWithFields, PDFData, SyncTask } from "@/types";
import { selectPapers } from "./batch-processor";
import { db } from "./db";
import { addFile } from "./files-manager";
import { getJob, updateJob } from "./job-manager";
import {
  blobToPdfDataUrl,
  buildChatRequestBody,
  classifyRequestError,
  createChatCompletion,
  createUserPrompt,
  DEFAULT_MAX_COMPLETION_TOKENS,
  resolveSystemPrompt,
} from "./openai-service";
import { PDFMatch } from "./pdf-utils";
import { abortableSleep, DEFAULT_RATE_LIMITS, getRateLimiter, parseResetDuration, RateLimiter } from "./rate-limiter";

/**
 * Synchronous processing: calls Chat Completions directly from the browser instead of the
 * Batch API. Every request is stored as a SyncTask in IndexedDB before it runs and updated
 * with its response, so progress survives reloads, interrupted jobs can be resumed, and the
 * CSV export reads results from the same place.
 *
 * In full-text mode the matched PDF files themselves are sent (as file_data), so OpenAI
 * parses the text and page images instead of relying on our pdf.js text extraction.
 */

export const DEFAULT_SYNC_CONCURRENCY = 4;
// OpenAI limit for files attached to a single Chat Completions request
const MAX_PDF_BYTES = 50 * 1024 * 1024;
// Starting estimate for the image OpenAI adds per PDF page; corrected from actual usage
const PDF_PAGE_IMAGE_TOKENS = 1000;
// Output allowance for models where max_completion_tokens is not sent (GPT-5 reasoning)
const UNBOUNDED_OUTPUT_ALLOWANCE = 4000;
const MAX_TRANSIENT_ATTEMPTS = 4;
const MAX_RATE_LIMIT_ATTEMPTS = 10;

const running = new Map<number, AbortController>();

export function syncBatchId(jobId: number, model: string): string {
  return `sync-${jobId}-${model}`;
}

export function isSyncJob(job: Pick<Job, "options">): boolean {
  return job.options?.processing === "sync";
}

export const syncProcessor = {
  /** Whether this browser tab is currently working on the job */
  isRunning: (jobId: number) => running.has(jobId),

  start: async (
    jobId: number,
    papers: PaperWithFields[],
    pdfParams?: { pdfData: Array<PDFData>; matches: Array<PDFMatch>; files: File[] }
  ) => {
    const job = await getJob(jobId);
    if (!job) {
      throw new Error("Job not found");
    }
    const sendPdfs = job.mode === "fulltext" && !!pdfParams;

    // Remember which PDF belongs to which paper before selection reorders/filters them
    const pdfIndexByPaper = new Map<PaperWithFields, number>();
    for (const match of pdfParams?.matches ?? []) {
      const paper = papers[match.paperIndex];
      if (paper) pdfIndexByPaper.set(paper, match.pdfIndex);
    }

    // When the PDF is sent, a missing text layer (e.g. scanned PDF) is no reason to skip a paper
    const selected = selectPapers(papers, job.fields.custom, pdfParams, { requireExtractedText: !sendPdfs });

    // Store each PDF once; tasks for every model reference it by file id
    const pdfFileIds = new Map<number, number>();
    if (sendPdfs) {
      for (const paper of selected) {
        const pdfIndex = pdfIndexByPaper.get(paper);
        const file = pdfIndex !== undefined ? pdfParams!.files[pdfIndex] : undefined;
        if (file && pdfIndex !== undefined && !pdfFileIds.has(pdfIndex)) {
          const stored = await addFile(jobId, file, file.name);
          pdfFileIds.set(pdfIndex, stored.id);
        }
      }
    }

    const models: string[] = job.options?.models?.length ? job.options.models : [job.options?.model || "gpt-4.1"];
    const tasks: SyncTask[] = [];
    for (const model of models) {
      for (const paper of selected) {
        const pdfIndex = pdfIndexByPaper.get(paper);
        const pdfFileId = sendPdfs && pdfIndex !== undefined ? pdfFileIds.get(pdfIndex) : undefined;
        tasks.push({
          jobId,
          model,
          customId: `request-${paper.id}`,
          status: "pending",
          userPrompt: createUserPrompt(paper, { pdfAttached: pdfFileId !== undefined }),
          pdfFileId,
          pdfFilename: pdfFileId !== undefined ? pdfParams!.files[pdfIndex!].name : undefined,
          pdfPages: pdfFileId !== undefined ? pdfParams!.pdfData[pdfIndex!]?.pages : undefined,
          pdfTextChars: pdfFileId !== undefined ? pdfParams!.pdfData[pdfIndex!]?.fulltext?.length ?? 0 : undefined,
        });
      }
    }
    await db.syncTasks.bulkAdd(tasks);

    await updateJob(jobId, {
      status: "in_progress",
      error: undefined,
      total: selected.length * models.length,
      progress: 0,
      batchId: syncBatchId(jobId, models[0]),
      batches: models.map((model) => ({
        model,
        batchId: syncBatchId(jobId, model),
        status: "in_progress",
        completed: 0,
        failed: 0,
        total: selected.length,
      })),
    });

    void run(jobId);
  },

  /** Continue an interrupted or stopped job; failed requests are retried */
  resume: async (jobId: number) => {
    void run(jobId);
  },

  /** Stop after the requests currently in flight; the job can be resumed later */
  stop: (jobId: number) => {
    running.get(jobId)?.abort();
  },

  /** Remove stored tasks/results (call when deleting a job) */
  deleteTasks: async (jobId: number) => {
    running.get(jobId)?.abort();
    await db.syncTasks.where("jobId").equals(jobId).delete();
  },

  /** Results in the same shape as Batch API output lines, for the CSV export */
  getResults: async (jobId: number, model: string) => {
    const tasks = await db.syncTasks.where("[jobId+model]").equals([jobId, model]).toArray();
    return tasks
      .filter((task) => task.status === "done")
      .map((task) => ({ custom_id: task.customId, response: { status_code: 200, body: task.response } }));
  },
};

async function run(jobId: number) {
  if (running.has(jobId)) return;
  const controller = new AbortController();
  running.set(jobId, controller);
  let fatalError: string | undefined;

  try {
    const job = await getJob(jobId);
    if (!job) return;

    const allTasks = await db.syncTasks.where("jobId").equals(jobId).toArray();
    const todo = allTasks.filter((task) => task.status !== "done");
    const models = job.batches?.map((b) => b.model) ?? [...new Set(allTasks.map((t) => t.model))];

    // Failed requests are retried, so only "done" counts carry over
    const counts = new Map(models.map((model) => [model, { done: 0, failed: 0, total: 0 }]));
    for (const task of allTasks) {
      const c = counts.get(task.model);
      if (!c) continue;
      c.total++;
      if (task.status === "done") c.done++;
    }

    const persistProgress = async (finalStatus?: { aborted: boolean }) => {
      if (!(await getJob(jobId))) return; // job was deleted
      const batches = models.map((model) => {
        const c = counts.get(model)!;
        let status = "in_progress";
        if (finalStatus) {
          if (finalStatus.aborted) status = "cancelled";
          else status = c.done > 0 || c.total === 0 ? "completed" : "failed";
        }
        return {
          model,
          batchId: syncBatchId(jobId, model),
          status,
          completed: c.done,
          failed: c.failed,
          total: c.total,
        };
      });
      const progress = batches.reduce((sum, b) => sum + b.completed, 0);
      let status: Job["status"] = "in_progress";
      if (finalStatus) {
        if (finalStatus.aborted) status = "cancelled";
        else status = batches.every((b) => b.status === "failed") ? "failed" : "completed";
      }
      await updateJob(jobId, { status, progress, batches, updated: new Date() });
    };

    await persistProgress();
    await updateJob(jobId, { error: undefined });
    if (todo.length === 0) {
      await persistProgress({ aborted: false });
      return;
    }

    const systemPrompt = resolveSystemPrompt(job.fields, job.options);

    // Each PDF is read once and shared by the tasks (one per model) that use it
    const remainingUses = new Map<number, number>();
    for (const task of todo) {
      if (task.pdfFileId !== undefined) {
        remainingUses.set(task.pdfFileId, (remainingUses.get(task.pdfFileId) ?? 0) + 1);
      }
    }
    const dataUrls = new Map<number, Promise<string>>();
    const getPdfDataUrl = async (fileId: number) => {
      if (!dataUrls.has(fileId)) {
        dataUrls.set(fileId, (async () => {
          const stored = await db.files.get(fileId);
          if (!stored?.file) throw new Error("Stored PDF not found");
          if (stored.file.size > MAX_PDF_BYTES) throw new Error("PDF is larger than OpenAI's 50 MB limit");
          return blobToPdfDataUrl(stored.file);
        })());
      }
      return dataUrls.get(fileId)!;
    };
    const releasePdf = (fileId?: number) => {
      if (fileId === undefined) return;
      const left = (remainingUses.get(fileId) ?? 1) - 1;
      remainingUses.set(fileId, left);
      if (left <= 0) dataUrls.delete(fileId);
    };

    // Tasks are ordered so both models' requests for the same PDF run close together
    todo.sort((a, b) => (a.pdfFileId ?? 0) - (b.pdfFileId ?? 0) || a.customId.localeCompare(b.customId));

    const limits = {
      rpm: job.options?.rpmLimit || DEFAULT_RATE_LIMITS.rpm,
      tpm: job.options?.tpmLimit || DEFAULT_RATE_LIMITS.tpm,
    };
    const limiters = new Map(models.map((model) => [model, getRateLimiter(model, limits)]));
    const estimator = new TokenEstimator(systemPrompt.length, job.options?.max_completion_tokens);
    const consecutive429 = new Map<string, number>();
    const calibrating = new Map<string, Promise<void>>();

    let next = 0;
    const concurrency = Math.max(1, Math.min(16, job.options?.concurrency || DEFAULT_SYNC_CONCURRENCY));
    const worker = async () => {
      while (!controller.signal.aborted) {
        const task = todo[next++];
        if (!task) return;
        const c = counts.get(task.model)!;
        const limiter = limiters.get(task.model)!;
        let rateLimitAttempts = 0;
        let transientAttempts = 0;
        let outcome: { status: "done"; response: unknown } | { status: "error"; error: string } | undefined;

        // Until a model has returned one PDF response, its token estimate is a guess:
        // run that first PDF request alone so parallel requests cannot overshoot the TPM limit.
        const usesPdf = task.pdfFileId !== undefined;
        let releaseCalibration: (() => void) | undefined;
        while (usesPdf && !estimator.isCalibrated(task.model) && !controller.signal.aborted) {
          const inFlight = calibrating.get(task.model);
          if (!inFlight) {
            let resolve!: () => void;
            calibrating.set(task.model, new Promise<void>((r) => (resolve = r)));
            releaseCalibration = () => {
              calibrating.delete(task.model);
              resolve();
            };
            break;
          }
          await inFlight;
        }

        while (!outcome && !controller.signal.aborted) {
          const estimate = estimator.estimate(task);
          let settle: ((actualTokens: number) => void) | undefined;
          try {
            settle = await limiter.acquire(estimate.total, controller.signal);
            const pdf = task.pdfFileId !== undefined
              ? { filename: task.pdfFilename || "paper.pdf", dataUrl: await getPdfDataUrl(task.pdfFileId) }
              : undefined;
            const body = buildChatRequestBody(systemPrompt, task.userPrompt, { ...job.options, model: task.model }, pdf);
            const { completion, headers } = await createChatCompletion(body, controller.signal);
            const promptTokens = completion.usage?.prompt_tokens;
            if (promptTokens) {
              settle(promptTokens + estimate.output);
              estimator.learn(task, promptTokens);
            }
            applyRateLimitHeaders(limiter, headers, estimate.total);
            consecutive429.set(task.model, 0);
            // Store a plain copy (SDK objects can carry non-cloneable fields)
            outcome = { status: "done", response: JSON.parse(JSON.stringify(completion)) };
          } catch (error) {
            const { kind, retryAfterMs, message } = classifyRequestError(error);
            if (kind === "aborted" || controller.signal.aborted) break;
            if (kind === "rate_limit" && ++rateLimitAttempts <= MAX_RATE_LIMIT_ATTEMPTS) {
              // Pause every request for this model, not just this one
              const n = (consecutive429.get(task.model) ?? 0) + 1;
              consecutive429.set(task.model, n);
              const backoff = Math.min(60_000, 1000 * 2 ** Math.min(n, 6)) + Math.random() * 1000;
              limiter.pauseFor(retryAfterMs ?? backoff);
              continue;
            }
            if (kind === "transient" && ++transientAttempts < MAX_TRANSIENT_ATTEMPTS) {
              await abortableSleep(retryAfterMs ?? 2000 * 2 ** transientAttempts, controller.signal).catch(() => {});
              continue;
            }
            if (kind === "quota" || kind === "fatal_auth") {
              fatalError = kind === "quota"
                ? "OpenAI reports insufficient quota (out of credit or over the billing limit). Add credit, then resume the job."
                : `OpenAI rejected the API key (${message}). Check Settings, then resume the job.`;
              controller.abort();
              break;
            }
            console.error(`Synchronous request ${task.customId} (${task.model}) failed:`, error);
            outcome = {
              status: "error",
              error: kind === "too_large" ? `Request too large for this model or your token limit: ${message}` : message,
            };
          }
        }

        releaseCalibration?.();
        releasePdf(task.pdfFileId);
        if (!outcome) return; // stopped: the task stays pending and is resumable
        await db.syncTasks.update(task.id!, {
          status: outcome.status,
          response: outcome.status === "done" ? outcome.response : undefined,
          error: outcome.status === "error" ? outcome.error : undefined,
          attempts: (task.attempts ?? 0) + 1 + rateLimitAttempts + transientAttempts,
        });
        if (outcome.status === "done") c.done++;
        else c.failed++;
        await persistProgress();
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, worker));

    if (fatalError) {
      await persistProgress({ aborted: true });
      await updateJob(jobId, { status: "failed", error: fatalError, updated: new Date() });
    } else {
      await persistProgress({ aborted: controller.signal.aborted });
    }
  } catch (error) {
    console.error(`Synchronous job ${jobId} stopped with an error:`, error);
    if (await getJob(jobId)) {
      await updateJob(jobId, { status: "failed", updated: new Date() });
    }
  } finally {
    running.delete(jobId);
  }
}

/**
 * Token estimate per request for the rate limiter: prompt text, the PDF (its text plus the page
 * image OpenAI adds per page) and the output allowance, which OpenAI also counts toward TPM.
 * The PDF part is calibrated per model from the prompt_tokens OpenAI actually reports.
 */
class TokenEstimator {
  private pdfFactor = new Map<string, number>();
  private systemPromptChars: number;
  private outputAllowance: number;

  constructor(systemPromptChars: number, maxCompletionTokens?: number) {
    this.systemPromptChars = systemPromptChars;
    this.outputAllowance = maxCompletionTokens || DEFAULT_MAX_COMPLETION_TOKENS;
  }

  private textTokens(task: SyncTask) {
    return Math.ceil((this.systemPromptChars + task.userPrompt.length) / 4) + 20;
  }

  private rawPdfTokens(task: SyncTask) {
    if (task.pdfFileId === undefined) return 0;
    return Math.ceil((task.pdfTextChars ?? 0) / 4) + (task.pdfPages ?? 10) * PDF_PAGE_IMAGE_TOKENS;
  }

  private output(task: SyncTask) {
    return task.model.toLowerCase().startsWith("gpt-5") ? UNBOUNDED_OUTPUT_ALLOWANCE : this.outputAllowance;
  }

  estimate(task: SyncTask) {
    const pdf = this.rawPdfTokens(task) * (this.pdfFactor.get(task.model) ?? 1);
    const output = this.output(task);
    return { total: Math.ceil(this.textTokens(task) + pdf + output), output };
  }

  isCalibrated(model: string) {
    return this.pdfFactor.has(model);
  }

  learn(task: SyncTask, actualPromptTokens: number) {
    const raw = this.rawPdfTokens(task);
    if (raw <= 0) return;
    const observed = Math.max(0, actualPromptTokens - this.textTokens(task)) / raw;
    const previous = this.pdfFactor.get(task.model);
    // The first observation replaces the guess; later ones are smoothed and clamped so one
    // odd PDF cannot swing the estimate too far. A 10% margin keeps us on the safe side.
    const next = previous === undefined ? observed * 1.1 : previous * 0.7 + observed * 1.1 * 0.3;
    this.pdfFactor.set(task.model, Math.min(5, Math.max(0.2, next)));
  }
}

/**
 * If the browser can read OpenAI's x-ratelimit-* headers, pause before the limit is hit.
 * (They may not be exposed via CORS; the client-side limiter and 429 handling cover that case.)
 */
function applyRateLimitHeaders(limiter: RateLimiter, headers: Headers, nextRequestTokens: number) {
  const remainingRequests = Number(headers.get("x-ratelimit-remaining-requests"));
  const remainingTokens = Number(headers.get("x-ratelimit-remaining-tokens"));
  if (headers.get("x-ratelimit-remaining-requests") !== null && remainingRequests <= 1) {
    const ms = parseResetDuration(headers.get("x-ratelimit-reset-requests"));
    if (ms) limiter.pauseFor(ms);
  }
  if (headers.get("x-ratelimit-remaining-tokens") !== null && remainingTokens < nextRequestTokens) {
    const ms = parseResetDuration(headers.get("x-ratelimit-reset-tokens"));
    if (ms) limiter.pauseFor(ms);
  }
}

"use client";

import type React from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { useCustomFields } from "@/hooks/use-custom-fields";
import { processBatch } from "@/lib/batch-processor";
import { addFile } from "@/lib/files-manager";
import { createJob, updateJob } from "@/lib/job-manager";
import { estimateTokens, extractPdfDataBatch, matchPdfsToPapersAsync, PDFMatch, stripReferences } from "@/lib/pdf-utils";
import { cn, downloadFile } from "@/lib/utils";
import { Paper, PDFData,PaperWithFields } from "@/types";
import { Check, ChevronsUpDown, Download, Eye, Loader2, Plus, RefreshCw, Trash2, Upload, X } from "lucide-react";
import Papa from "papaparse";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { createSystemPrompt, DEFAULT_MAX_COMPLETION_TOKENS, DEFAULT_TEMPERATURE, listAvailableModels } from "@/lib/openai-service";
import SystemPromptViewer from "./SystemPromptViewer";
import { useNavigate } from 'react-router-dom';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { HelpText } from "./help-text";

export default function ExtractFields() {
  const [mode, setMode] = useState<"fulltext" | "abstract">("abstract");
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [selectedModels, setSelectedModels] = useState<string[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelPopoverOpen, setModelPopoverOpen] = useState(false);

  const toggleModel = (model: string) => {
    setSelectedModels((prev) =>
      prev.includes(model) ? prev.filter((m) => m !== model) : [...prev, model]
    );
  };
  const [file, setFile] = useState<File | null>(null);
  const [fileErrors, setFileErrors] = useState<string[]>([]);
  const currentCsvFile = file;
  const [pdfFolder, setPdfFolder] = useState<FileList | null>(null);
  const [pdfData, setPdfData] = useState<Array<PDFData>>([]);
  const [extractDesign, setExtractDesign] = useState(true);
  const [extractMethod, setExtractMethod] = useState(true);
  const [extractJustification, setExtractJustification] = useState(true);
  const { customFields, addCustomField, removeCustomField, updateCustomField, downloadCustomFields, handleUploadCustomFields } = useCustomFields();
  const [processingPdfs, setProcessingPdfs] = useState(false);
  const [processingProgress, setProcessingProgress] = useState({ current: 0, total: 0 });
  const [pdfMatches, setPdfMatches] = useState<PDFMatch[]>([]);
  const [isMatching, setIsMatching] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [downloadJsonl, setDownloadJsonl] = useState(false);
  const [removeReferences, setRemoveReferences] = useState(true);
  const [temperature, setTemperature] = useState(String(DEFAULT_TEMPERATURE));
  const [maxCompletionTokens, setMaxCompletionTokens] = useState(String(DEFAULT_MAX_COMPLETION_TOKENS));
  const [systemPromptOverride, setSystemPromptOverride] = useState<string | undefined>(undefined);
  const navigate = useNavigate();
  // Sync justification checkbox with customFields
  useEffect(() => {
    const hasJustification = customFields.some(
      field => field.name.toLowerCase() === "justification"
    );
    if (hasJustification && !extractJustification) {
      setExtractJustification(true);
    }
  }, [customFields, extractJustification]);

  const loadModels = async (forceRefresh: boolean = false) => {
    setModelsLoading(true);
    try {
      const models = await listAvailableModels(forceRefresh);
      if (models && models.length) {
        setAvailableModels(models);
        setSelectedModels((prev) => {
          const stillAvailable = prev.filter((m) => models.includes(m));
          if (stillAvailable.length > 0) return stillAvailable;
          const preferredDefaults = [
            "gpt-5.6-luna",
            "gpt-5.6-terra",
            "gpt-5.6-sol",
            "gpt-5.6",
            "gpt-5-mini",
            "gpt-5",
            "gpt-4.1-mini",
            "gpt-4.1",
          ];
          const defaultModel = preferredDefaults.find((p) => models.includes(p)) ?? models[0];
          return [defaultModel];
        });
        if (forceRefresh) {
          toast.success(`Loaded ${models.length} models from OpenAI`);
        }
      }
    } catch (e) {
      console.error("Failed to load models", e);
      const errorMessage = e instanceof Error ? e.message : "Unknown error occurred";
      if (errorMessage.includes("API key")) {
        toast.error("OpenAI API key not configured. Please set it in Settings.");
      } else if (errorMessage.includes("network") || errorMessage.includes("fetch")) {
        toast.error("Network error: Unable to connect to OpenAI. Please check your internet connection.");
      } else {
        toast.error(`Failed to load available models: ${errorMessage}`);
      }
    } finally {
      setModelsLoading(false);
    }
  };

  useEffect(() => {
    loadModels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);


  const validateCsvColumns = (csvData: string): Promise<boolean> => {
    return new Promise((resolve, reject) => {
      Papa.parse(csvData, {
        header: true,
        skipEmptyLines: true,
        complete: (results) => {
          const headers = results.meta.fields || [];
          const requiredColumns = ['title', 'abstract', "doi"];
          const missingColumns = requiredColumns.filter(
            col => !headers.some(header => header.toLowerCase() === col.toLowerCase())
          );

          if (missingColumns.length > 0) {
            toast.error(`Missing required columns: ${missingColumns.join(', ')}`);
            setFileErrors([`Missing required columns: ${missingColumns.join(', ')}`]);
            resolve(false);
          } else {
            const paperCount = results.data.length;
            toast.success(`CSV file validated successfully! Found ${paperCount} papers.`);
            setFileErrors([]);
            resolve(true);
          }
        },
        error: (error: any) => {
          const errorMessage = error?.message || "Unknown parsing error";
          toast.error(`CSV parsing error: ${errorMessage}. Please ensure the file is a valid CSV.`);
          reject(error);
        }
      });
    });
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const selectedFile = e.target.files[0];
      if (
        selectedFile.type === "text/csv" ||
        selectedFile.name.endsWith(".csv")
      ) {
        // Validate CSV columns
        const reader = new FileReader();
        reader.onload = async (event) => {
          if (event.target?.result) {
            const csvData = event.target.result as string;
            const isValid = await validateCsvColumns(csvData);
            if (isValid) {
              setFile(selectedFile);

              // If we have PDFs selected, try to match them
              if (pdfFolder && pdfFolder.length > 0) {
                try {
                  await performMatching((a) => setIsMatching(a), undefined, selectedFile);
                } catch (error) {
                  console.error("Error during matching:", error);
                  const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
                  toast.error(`Failed to match PDFs to CSV entries: ${errorMessage}`);
                }
              }
            } else {
              setFile(null);
            }
          }
        };
        reader.readAsText(selectedFile);
      } else {
        toast.error("Invalid file format. Please upload a CSV file.");
      }
    }
  };

  const handlePdfFolderChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      const pdfFiles = Array.from(e.target.files);

      setProcessingPdfs(true);
      setProcessingProgress({ current: 0, total: pdfFiles.length });

      toast("Extracting PDF data, please wait...");
      console.time("Extracting PDF data");

      try {
        // Use batch processing to avoid multiple worker instances
        const pdfDataResults = await extractPdfDataBatch(
          pdfFiles,
          (current, total, fileName) => {
            // Update progress
            setProcessingProgress({ current, total });
            const progress = Math.round((current / total) * 100);
            console.log(`Processing ${fileName} (${current}/${total} - ${progress}%)`);
          }
        );

        console.timeEnd("Extracting PDF data");
        setPdfData(pdfDataResults);
        setPdfFolder(e.target.files);
        toast.success(`Successfully processed ${e.target.files.length} PDF files`);

        // If we have a CSV file selected, try to match the PDFs
        if (file) {
          try {
            await performMatching((a) => setIsMatching(a), pdfDataResults);
          } catch (error) {
            console.error("Error during matching:", error);
            const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
            toast.error(`Failed to match PDFs to CSV entries: ${errorMessage}`);
          }
        }
      } catch (error) {
        console.error("Error processing PDFs:", error);
        const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
        if (errorMessage.includes("PDF.js")) {
          toast.error("PDF processing error: One or more PDF files may be corrupted or password-protected. Please check your files.");
        } else if (errorMessage.includes("memory") || errorMessage.includes("Memory")) {
          toast.error("Out of memory: Too many PDFs to process at once. Please try with fewer files.");
        } else {
          toast.error(`Failed to process PDF files: ${errorMessage}`);
        }
      } finally {
        setProcessingPdfs(false);
        setProcessingProgress({ current: 0, total: 0 });
      }
    }
  };

  const performMatching = async (isProcessing: (a: boolean) => void, pdfDataToUse?: PDFData[], csvFile?: File) => {
    // csvFile is passed when called right after setFile(), before state has updated
    const file = csvFile ?? currentCsvFile;
    if (!file) {
      console.error("No CSV file selected for matching");
      return;
    }
    const dataToMatch = pdfDataToUse || pdfData;
    if (!dataToMatch || dataToMatch.length === 0) {
      toast.error("No PDF files available for matching. Please upload PDF files.");
      return;
    }
    try {
      const readCsvAsText = (file: File): Promise<string> =>
        new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = (event) => {
            if (event.target?.result) {
              resolve(event.target.result as string);
            } else {
              reject(new Error("Failed to read CSV file"));
            }
          };
          reader.onerror = reject;
          reader.readAsText(file);
        });

      isProcessing(true);
      console.log("Matching PDFs to CSV entries...");

      try {
        const csvData = await readCsvAsText(file);
        const tempResults = await new Promise<Papa.ParseResult<any>>(
          (resolve, reject) => {
            Papa.parse(csvData, {
              header: true,
              skipEmptyLines: true,
              complete: (results) => resolve(results),
              error: (error: any) => reject(error),
            });
          }
        );
        const papers = (tempResults.data as any[]).map((row, index) => {
          const normalizedRow: { [key: string]: string } = {};
          Object.keys(row).forEach(key => {
            normalizedRow[key.toLowerCase()] = row[key] || "";
          });

          return {
            id: index + 1,
            title: normalizedRow.title || "",
            abstract: normalizedRow.abstract || "",
            authors: normalizedRow.authors || "",
            doi: normalizedRow.doi || "",
            keywords: normalizedRow.keywords || "",
          };
        }) as Paper[];

        // Perform the matching using the extracted PDF data and CSV papers
        const matches = await matchPdfsToPapersAsync(dataToMatch, papers, 0.5, (...args) => {
          console.log("Matching PDFs to CSV entries...", ...args);
        });
        setPdfMatches(matches);

        if (matches.length > 0) {
          toast.success(`Successfully matched ${matches.length} PDF files to CSV entries`);
          console.log('PDF Matches:', matches);
        } else {
          toast.warning("No PDF files could be matched to CSV entries. Files will be processed based on filename similarity.");
        }
      } catch (error) {
        console.error("Error parsing CSV data:", error);
        const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
        toast.error(`CSV parsing error: ${errorMessage}. Please ensure your CSV file is valid.`);
      }
      isProcessing(false);
    } catch (error) {
      console.error("Error matching PDFs:", error);
      const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
      toast.error(`Failed to match PDFs: ${errorMessage}`);
      isProcessing(false);
    }
  };


  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!file) {
      toast("No file selected. Please upload a CSV file.");
      return;
    }

    if (!selectedModels || selectedModels.length === 0) {
      toast.error("Please select at least one model.");
      return;
    }

    if (mode === "fulltext" && (!pdfFolder || pdfFolder.length === 0)) {
      toast.error("Please select a folder with PDF files for full text mode.");
      return;
    }

    const parsedTemperature = Number(temperature);
    if (!Number.isFinite(parsedTemperature) || parsedTemperature < 0 || parsedTemperature > 2) {
      toast.error("Temperature must be a number between 0 and 2.");
      return;
    }

    const parsedMaxTokens = Number(maxCompletionTokens);
    if (!Number.isFinite(parsedMaxTokens) || parsedMaxTokens < 1 || !Number.isInteger(parsedMaxTokens)) {
      toast.error("Max completion tokens must be a whole number of at least 1.");
      return;
    }

    setIsSubmitting(true);
    try {
      // Prepare custom fields, including justification if enabled
      const allCustomFields = [...customFields];
      
      // Add justification field if enabled and not already present
      if (extractJustification) {
        const justificationExists = allCustomFields.some(
          field => field.name.toLowerCase() === "justification"
        );
        if (!justificationExists) {
          allCustomFields.push({
            name: "Justification",
            instruction: "Provide a brief justification with quotes from the paper for your choices. Provide one sentence per extracted/decided field.",
            type: "text",
            recheck_yes: false,
            recheck_no: false,
            force_recheck: false,
          });
        } else {
          // Update existing justification field with the correct instruction
          const justificationIndex = allCustomFields.findIndex(
            field => field.name.toLowerCase() === "justification"
          );
          if (justificationIndex >= 0) {
            allCustomFields[justificationIndex] = {
              ...allCustomFields[justificationIndex],
              instruction: "Provide a brief justification with quotes from the paper for your choices. Provide one sentence per extracted/decided field.",
              type: "text",
            };
          }
        }
      } else {
        // Remove justification if disabled
        const justificationIndex = allCustomFields.findIndex(
          field => field.name.toLowerCase() === "justification"
        );
        if (justificationIndex >= 0) {
          allCustomFields.splice(justificationIndex, 1);
        }
      }

      // Create fields configuration
      const fields = {
        design: extractDesign,
        method: extractMethod,
        custom: allCustomFields.map((field) => ({
          name: field.name,
          instruction: field.instruction,
          type: field.type || "boolean",
          recheck_yes: field.recheck_yes || false,
          recheck_no: field.recheck_no || false,
          force_recheck: field.force_recheck || false,
        })),
      };

      // Read and parse the CSV file
      const csvData = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (event) => {
          if (event.target?.result) {
            resolve(event.target.result as string);
          } else {
            reject(new Error("Failed to read CSV file"));
          }
        };
        reader.onerror = reject;
        reader.readAsText(file);
      });

      const results = await new Promise<Papa.ParseResult<any>>(
        (resolve, reject) => {
          Papa.parse(csvData, {
            header: true,
            skipEmptyLines: true,
            complete: (results) => resolve(results),
            error: (error: any) => reject(error),
          });
        }
      );

      const papers = (results.data as any[]).map((row, index) => {
        // Create a case-insensitive mapping of the row data
        const normalizedRow: { [key: string]: string } = {};
        Object.keys(row).forEach(key => {
          normalizedRow[key.toLowerCase()] = row[key] || "";
        });

        // IMPORTANT: id must come AFTER spread to ensure sequential IDs (1, 2, 3...)
        // regardless of any 'id' column in the original CSV
        return {...normalizedRow, id: index + 1} as PaperWithFields
      }) as PaperWithFields[];

      const job = await createJob({
        filename: file.name,
        mode,
        fields,
        status: "in_progress",
        progress: 0,
        total: papers.length * (selectedModels.length || 1),
        created: new Date(),
        updated: new Date(),
        options:{
          model: selectedModels[0],
          models: selectedModels,
          downloadJsonl: downloadJsonl,
          temperature: parsedTemperature,
          max_completion_tokens: parsedMaxTokens,
          systemPromptOverride,
          paperIdScheme: "row_index",
        }
      });

      try {
        await addFile(job.id, file, file.name);
        const pdfParams = mode === "fulltext" ? {
          pdfData: removeReferences
            ? pdfData.map((pdf) => ({ ...pdf, fulltext: stripReferences(pdf.fulltext || "") }))
            : Array.from(pdfData),
          matches: pdfMatches,
        } : undefined;
        await processBatch.start(job.id, papers, pdfParams);

        toast.success("Job started successfully!");
        navigate('/job-management');
      } catch (error) {
        // update job status to failed
        await updateJob(job.id, {
          status: "failed",
        });
        console.error("Error creating or starting job:", error);
        const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
        if (errorMessage.includes("API key")) {
          toast.error("OpenAI API key not configured or invalid. Please check Settings.");
        } else if (errorMessage.includes("No papers with full text")) {
          toast.error("No papers have matching PDFs with full text. Please check your PDF files and matching results.");
        } else if (errorMessage.includes("recheck settings")) {
          toast.error(`${errorMessage} Adjust the Recheck options on your custom fields.`);
        } else if (errorMessage.includes("quota") || errorMessage.includes("rate limit")) {
          toast.error("OpenAI API quota exceeded or rate limit reached. Please try again later or check your OpenAI account.");
        } else if (errorMessage.includes("network") || errorMessage.includes("fetch")) {
          toast.error("Network error: Unable to connect to OpenAI. Please check your internet connection.");
        } else {
          toast.error(`Failed to start screening job: ${errorMessage}`);
        }
      }
    } catch (error) {
      console.error("Error starting job:", error);
      const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
      if (errorMessage.includes("Failed to read CSV")) {
        toast.error("CSV file could not be read. Please ensure the file is not corrupted.");
      } else {
        toast.error(`Failed to prepare screening job: ${errorMessage}`);
      }
    } finally {
      setIsSubmitting(false);
    }
  };
  // Summary of what full-text mode will actually send
  const fulltextStats = useMemo(() => {
    const matchedWithoutText = pdfMatches
      .map((match) => pdfData[match.pdfIndex])
      .filter((pdf) => pdf && !pdf.fulltext?.trim());
    const tokensPerModel = pdfMatches.reduce((sum, match) => {
      const text = pdfData[match.pdfIndex]?.fulltext || "";
      return sum + estimateTokens(removeReferences ? stripReferences(text) : text);
    }, 0);
    return {
      matchedWithoutText,
      tokensPerModel,
      totalTokens: tokensPerModel * Math.max(selectedModels.length, 1),
    };
  }, [pdfMatches, pdfData, removeReferences, selectedModels.length]);

  const downloadUnmatchedPdfs = () => {
    if (!pdfData || pdfData.length === 0) {
      toast.error("No PDF's to download");
      return;
    }
    const matchedIndexes = new Set(pdfMatches.map(match => match.pdfIndex));
    const unmatchedPdfsFileNames = pdfData.filter((_, index) => !matchedIndexes.has(index)).map(pdf => pdf.filename);
    const noTextFileNames = fulltextStats.matchedWithoutText.map(pdf => pdf.filename);
    if (unmatchedPdfsFileNames.length === 0 && noTextFileNames.length === 0) {
      toast.info("All PDFs are matched.");
      return;
    }
    const sections = [];
    if (unmatchedPdfsFileNames.length > 0) {
      sections.push(`# Not matched to any CSV row (${unmatchedPdfsFileNames.length})`, ...unmatchedPdfsFileNames, "");
    }
    if (noTextFileNames.length > 0) {
      sections.push(`# Matched, but no extractable text - likely scanned or protected; will be skipped (${noTextFileNames.length})`, ...noTextFileNames);
    }
    downloadFile("unmatched_pdfs.txt", sections.join("\n"), "text/plain");
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div className="bg-blue-50 dark:bg-blue-950 border border-blue-200 dark:border-blue-800 rounded-lg p-4 space-y-2 mb-6">
        <h4 className="font-semibold text-sm">Getting Started</h4>
        <ol className="list-decimal list-inside text-sm text-muted-foreground space-y-1 ml-2">
          <li>
            Configure your OpenAI API key in <a href="/#/settings" onClick={(e) => { e.preventDefault(); navigate('/settings'); }} className="text-blue-600 hover:underline cursor-pointer">Settings</a> (required for screening)
          </li>
          <li>Upload your CSV file with papers (must include Title, Abstract, and DOI columns)</li>
          <li>Select screening mode: Abstract Only (faster) or Full Text (requires PDF upload)</li>
          <li>Choose one or more LLM models to run screening</li>
          <li>Configure fields to screen (default fields or add custom fields)</li>
          <li>Click "Start Screening" to create a batch job</li>
          <li>Monitor progress in <a href="/#/job-management" onClick={(e) => { e.preventDefault(); navigate('/job-management'); }} className="text-blue-600 hover:underline cursor-pointer">Job Management</a></li>
        </ol>
      </div>
      <div className="space-y-4">
        <div>
          <h3 className="text-lg font-medium">Screening Mode</h3>
          <p className="text-sm text-muted-foreground">
            Choose how to screen articles based on criteria
          </p>
          <HelpText 
            text="Abstract mode is faster and cheaper, while full text provides more detailed screening. Full text requires matching PDF files."
            linkTo="/#/manual#extract-fields"
            linkText="Learn more about screening modes"
            className="mt-1"
          />
        </div>

        <RadioGroup
          value={mode}
          onValueChange={(value) => {
            setMode(value as "fulltext" | "abstract");
            // Clear PDF-related state when switching to abstract mode
            if (value === "abstract") {
              setPdfFolder(null);
              setPdfMatches([]);
            }
          }}
        >
          <div className="flex items-center space-x-2">
            <RadioGroupItem value="abstract" id="abstract" />
            <Label htmlFor="abstract">Title and Abstract Only</Label>
          </div>
          <div className="flex items-center space-x-2">
            <RadioGroupItem value="fulltext" id="fulltext" />
            <Label htmlFor="fulltext">Full Text (Requires PDF download)</Label>
          </div>
        </RadioGroup>
        <div className="text-sm text-red-600 font-medium mt-2">
          ⚠️ Warning: Full text mode is experimental and not thoroughly tested. Use with caution.
        </div>
      </div>

      <Separator />
      <div className="space-y-4">
        <div>
          <h3 className="text-lg font-medium">Model</h3>
          <p className="text-sm text-muted-foreground">Choose one or more OpenAI models</p>
          <HelpText 
            text="Selecting multiple models runs the same screening across all models for comparison. Each model creates a separate batch job."
            linkTo="/#/manual#extract-fields"
            linkText="Learn more about model selection"
            className="mt-1"
          />
        </div>
        <div className="grid w-full gap-2">
          <Label className="text-xs">OpenAI Models</Label>
          <div className="flex items-center gap-2">
            <Popover open={modelPopoverOpen} onOpenChange={setModelPopoverOpen}>
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  role="combobox"
                  aria-expanded={modelPopoverOpen}
                  className="w-full max-w-md justify-between font-normal cursor-pointer"
                  disabled={modelsLoading && availableModels.length === 0}
                >
                  {modelsLoading && availableModels.length === 0
                    ? "Loading models…"
                    : selectedModels.length === 0
                      ? "Select models…"
                      : selectedModels.length === 1
                        ? selectedModels[0]
                        : `${selectedModels.length} models selected`}
                  <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
                <Command>
                  <CommandInput placeholder="Search models…" />
                  <CommandList>
                    <CommandEmpty>No models found.</CommandEmpty>
                    <CommandGroup>
                      {availableModels.map((m) => (
                        <CommandItem key={m} value={m} onSelect={() => toggleModel(m)}>
                          <Check
                            className={cn(
                              "mr-2 h-4 w-4",
                              selectedModels.includes(m) ? "opacity-100" : "opacity-0"
                            )}
                          />
                          {m}
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
            <Button
              type="button"
              variant="outline"
              size="icon"
              onClick={() => loadModels(true)}
              disabled={modelsLoading}
              title="Refresh model list from OpenAI"
              className="shrink-0 cursor-pointer"
            >
              <RefreshCw className={cn("h-4 w-4", modelsLoading && "animate-spin")} />
            </Button>
          </div>
          {selectedModels.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {selectedModels.map((m) => (
                <Badge key={m} variant="secondary" className="gap-1">
                  {m}
                  <button
                    type="button"
                    onClick={() => toggleModel(m)}
                    className="cursor-pointer rounded-full hover:text-destructive"
                    title={`Remove ${m}`}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </Badge>
              ))}
            </div>
          )}
          <HelpText 
            text="You can run the same job across multiple models. Progress reflects all batches."
            className="mt-1"
          />
          <HelpText 
            text="Log probabilities can be enabled in Settings. When enabled, they are automatically requested for GPT-4.1 models only."
            linkTo="/#/manual#settings"
            linkText="Learn more about log probabilities"
            className="mt-1"
          />
          <div className="flex flex-wrap gap-4 mt-2">
            <div className="space-y-1">
              <Label htmlFor="temperature" className="text-xs">Temperature</Label>
              <Input
                id="temperature"
                type="number"
                min={0}
                max={2}
                step={0.1}
                value={temperature}
                onChange={(e) => setTemperature(e.target.value)}
                className="w-28"
              />
              <p className="text-xs text-muted-foreground">0–2 · default {DEFAULT_TEMPERATURE}</p>
            </div>
            <div className="space-y-1">
              <Label htmlFor="max-completion-tokens" className="text-xs">Max Completion Tokens</Label>
              <Input
                id="max-completion-tokens"
                type="number"
                min={1}
                step={1}
                value={maxCompletionTokens}
                onChange={(e) => setMaxCompletionTokens(e.target.value)}
                className="w-36"
              />
              <p className="text-xs text-muted-foreground">default {DEFAULT_MAX_COMPLETION_TOKENS} · not applied to GPT-5</p>
            </div>
          </div>
          <div className="flex flex-col gap-2 mt-2">
            <div className="flex items-center gap-2 cursor-pointer">
              <Checkbox
                id="downloadJsonl"
                checked={downloadJsonl}
                onCheckedChange={(checked) => setDownloadJsonl(checked === true)}
              />
              <Label htmlFor="downloadJsonl" className="text-sm">Download JSONL files for inspection</Label>
            </div>
          </div>
        </div>
      </div>

      <Separator />

      <div className="space-y-4">
        <div>
          <h3 className="text-lg font-medium">Upload Papers</h3>
          <p className="text-sm text-muted-foreground">
            Upload a CSV file with the following required columns: Title, Abstract, Authors, Keywords, DOI
          </p>
          <HelpText 
            text="CSV must include Title, Abstract, and DOI columns (case-insensitive). PDF files are matched automatically using metadata."
            linkTo="/#/manual#extract-fields"
            linkText="Learn more about CSV requirements"
            className="mt-1"
          />
          <HelpText 
            text="Other columns in your CSV can be present and will be preserved in the output CSV as-is (optional columns)."
            className="mt-1"
          />
        </div>

        <div className="grid w-full max-w-sm items-center gap-1.5">
          <Label htmlFor="csv">CSV File</Label>
          <Input
            id="csv"
            type="file"
            accept=".csv"
            onChange={handleFileChange}
          />
          {file && <p className="text-sm text-muted-foreground">{file.name}</p>}
        </div>
        {fileErrors.length > 0 && (
          <div className="text-sm text-red-500">
            {fileErrors.map((error, index) => (
              <p key={index}>{error}</p>
            ))}
          </div>
        )}

        {mode === "fulltext" && (
          <div className="grid w-full max-w-sm items-center gap-1.5">
            <Label htmlFor="pdf-folder">PDF Files</Label>
            <Input
              id="pdf-folder"
              type="file"
              accept=".pdf"
              multiple
              {...({ webkitdirectory: "" } as any)}
              onChange={handlePdfFolderChange}
              disabled={processingPdfs}
            />
            {processingPdfs && (
              <div className="text-sm text-muted-foreground">
                Processing PDFs: {processingProgress.current}/{processingProgress.total}
              </div>
            )}
            {pdfFolder && pdfFolder.length > 0 && !processingPdfs && (
              <p className="text-sm text-muted-foreground">
                {pdfFolder.length} PDF files selected and processed
              </p>
            )}
            <div className="flex items-center gap-2">
              <Checkbox
                id="removeReferences"
                checked={removeReferences}
                onCheckedChange={(checked) => setRemoveReferences(checked === true)}
              />
              <Label htmlFor="removeReferences" className="text-sm">Remove reference lists from full text (saves tokens, keeps appendices)</Label>
            </div>
            <HelpText 
              text="Select a folder containing PDF files. Files are matched to CSV rows by DOI (PDF metadata, first page, or a DOI filename such as 10_1016_j_xyz_2020_1.pdf), then by title or filename."
              linkTo="/#/manual#extract-fields"
              linkText="Learn more about PDF matching"
              className="mt-1"
            />
          </div>
        )}

        {mode === "fulltext" && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <h4 className="text-sm font-medium">PDF Matching Results</h4>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={async () => {
                  if (pdfFolder) {
                    console.log("Re-matching PDFs to CSV entries...");
                    try {
                      await performMatching((a) => setIsMatching(a));
                    } catch (error) {
                      console.error("Error during re-matching:", error);
                      const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
                      toast.error(`Failed to re-match PDFs: ${errorMessage}`);
                    }
                  }
                }}
                disabled={isMatching}
                className="text-xs"
              >
                {isMatching ? (
                  <>
                    <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                    Matching...
                  </>
                ) : (
                  "Re-match Files"
                )}
              </Button>
            </div>
            <div className="max-h-40 overflow-y-auto space-y-1">
              {/* Total matches: {pdfMatches.length} */}
              {pdfMatches.length > 0 && (
                <div className="text-xs text-muted-foreground">
                  Matched: {pdfMatches.length} out of {pdfData.length} PDFs
                  {" · "}≈{fulltextStats.tokensPerModel.toLocaleString()} input tokens per model
                </div>
              )}
              {fulltextStats.matchedWithoutText.length > 0 && (
                <div className="text-xs text-amber-600">
                  {fulltextStats.matchedWithoutText.length} matched PDFs have no extractable text (scanned or protected?) and will be skipped.
                </div>
              )}
              {fulltextStats.totalTokens > 1_000_000 && (
                <div className="text-xs text-amber-600">
                  Large job (≈{fulltextStats.totalTokens.toLocaleString()} tokens across all models). OpenAI limits how many batch tokens can be queued per model; if a batch fails right away, split the CSV into smaller jobs.
                </div>
              )}
              {/* Button to download unmatched PDFs list */}
              {(pdfMatches.length < pdfData.length || fulltextStats.matchedWithoutText.length > 0) && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={downloadUnmatchedPdfs}
                  className="text-xs"
                  disabled={isMatching}
                >
                  Download Unmatched PDFs
                </Button>
              )}
            </div>
          </div>
        )}
      </div>

      <Separator />

      <div className="space-y-4">
        <div>
          <h3 className="text-lg font-medium">Fields to Screen</h3>
          <p className="text-sm text-muted-foreground">
            Select which fields to screen articles based on
          </p>
          <HelpText 
            text="Default fields (Design, Method) are pre-configured. Custom fields allow you to define specific screening criteria with detailed instructions."
            linkTo="/#/manual#extract-fields"
            linkText="Learn more about field configuration"
            className="mt-1"
          />
        </div>

        <div className="space-y-2">
          <h4 className="text-sm font-medium">Default Fields</h4>
          <div className="flex items-center space-x-2 cursor-pointer">
            <Checkbox
              id="design"
              checked={extractDesign}
              onCheckedChange={(checked) => setExtractDesign(checked === true)}
            />
            <Label htmlFor="design">Design</Label>
          </div>
          <div className="flex items-center space-x-2 cursor-pointer">
            <Checkbox
              id="method"
              checked={extractMethod}
              onCheckedChange={(checked) => setExtractMethod(checked === true)}
            />
            <Label htmlFor="method">Method</Label>
          </div>
          <div className="flex items-center space-x-2 cursor-pointer">
            <Checkbox
              id="justification"
              checked={extractJustification}
              onCheckedChange={(checked) => setExtractJustification(checked === true)}
            />
            <Label htmlFor="justification">Justification</Label>
          </div>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-medium">
              Custom Fields
            </h4>
            <div className="flex items-center gap-2">
              <SystemPromptViewer
                extractDesign={extractDesign}
                extractMethod={extractMethod}
                customFields={[
                  ...(extractJustification ? [{
                    name: "Justification",
                    instruction: "Provide a brief justification with quotes from the paper for your choices. Provide one sentence per screened/decided field.",
                    type: "text" as const,
                  }] : []),
                  ...customFields
                ]}
                overridePrompt={systemPromptOverride}
                onSave={(value) => setSystemPromptOverride(value)}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={downloadCustomFields}
                className="cursor-pointer"
                title="Download custom fields as JSON"
              >
                <Download className="h-4 w-4 mr-1" /> Download
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => document.getElementById('upload-custom-fields')?.click()}
                className="cursor-pointer"
                title="Upload custom fields from JSON"
              >
                <Upload className="h-4 w-4 mr-1" /> Upload
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={addCustomField}
                className="cursor-pointer"
              >
                <Plus className="h-4 w-4 mr-1" /> Add Field
              </Button>
            </div>
          </div>

          {/* Hidden file input for uploading custom fields */}
          <input
            id="upload-custom-fields"
            type="file"
            accept=".json"
            onChange={handleUploadCustomFields}
            style={{ display: 'none' }}
          />

          <Accordion type="multiple" className="w-full">
            {customFields.map((field, index) => (
              <AccordionItem key={index} value={`field-${index}`}>
                <AccordionTrigger>
                  <div className="flex items-center justify-between w-full pr-2">
                    <div className="text-left">
                      <div className="text-sm font-medium">{field.name || `Custom Field ${index + 1}`}</div>
                      <div className="text-xs text-muted-foreground">{(field.type || "boolean").toUpperCase()}</div>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="ml-2"
                      onClick={(e) => { e.preventDefault(); removeCustomField(index); }}
                      title="Remove field"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </AccordionTrigger>
                <AccordionContent>
                  <div className="space-y-3 p-4 border rounded-lg">
                    <div className="grid grid-cols-[1fr_1fr] gap-2 items-start">
                      <div>
                        <Label htmlFor={`field-name-${index}`} className="text-xs">
                          Column Title
                        </Label>
                        <Input
                          id={`field-name-${index}`}
                          value={field.name}
                          onChange={(e) =>
                            updateCustomField(index, "name", e.target.value)
                          }
                          placeholder="e.g., Has Control Group"
                        />
                      </div>
                      <div>
                        <Label
                          htmlFor={`field-instruction-${index}`}
                          className="text-xs"
                        >
                          Instruction
                        </Label>
                        <Input
                          id={`field-instruction-${index}`}
                          value={field.instruction}
                          onChange={(e) =>
                            updateCustomField(index, "instruction", e.target.value)
                          }
                          placeholder="e.g., Does the paper include a control group?"
                        />
                      </div>
                    </div>
                    <div className="grid grid-cols-[1fr] gap-2 items-start">
                      <div>
                        <Label htmlFor={`field-type-${index}`} className="text-xs">
                          Field Type
                        </Label>
                        <Select value={field.type || "boolean"} onValueChange={(v) => updateCustomField(index, "type", v)}>
                          <SelectTrigger id={`field-type-${index}`}>
                            <SelectValue placeholder="Select type" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="boolean">Yes/No/Maybe</SelectItem>
                            <SelectItem value="text">Free Text</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                    {mode == "fulltext" && (field.type || "boolean") === "boolean" && <div className="space-y-2">
                      <Label className="text-xs font-medium">Options (select one)</Label>
                      <div className="flex flex-wrap gap-4">
                        <div className="flex items-center space-x-2">
                          <Checkbox
                            id={`recheck-yes-${index}`}
                            checked={field.recheck_yes || false}
                            onCheckedChange={(checked) =>
                              updateCustomField(index, "recheck_yes", checked === true)
                            }
                          />
                          <Label htmlFor={`recheck-yes-${index}`} className="text-xs">
                            Recheck Yes
                          </Label>
                        </div>
                        <div className="flex items-center space-x-2">
                          <Checkbox
                            id={`recheck-no-${index}`}
                            checked={field.recheck_no || false}
                            onCheckedChange={(checked) =>
                              updateCustomField(index, "recheck_no", checked === true)
                            }
                          />
                          <Label htmlFor={`recheck-no-${index}`} className="text-xs">
                            Recheck No
                          </Label>
                        </div>
                        <div className="flex items-center space-x-2">
                          <Checkbox
                            id={`force-recheck-${index}`}
                            checked={field.force_recheck || false}
                            onCheckedChange={(checked) =>
                              updateCustomField(index, "force_recheck", checked === true)
                            }
                          />
                          <Label htmlFor={`force-recheck-${index}`} className="text-xs">
                            Force Recheck
                          </Label>
                        </div>
                      </div>
                    </div>}
                  </div>
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </div>
      </div>

      <Button type="submit" className="w-full cursor-pointer" disabled={!file || (mode === "fulltext" && (!pdfFolder || pdfFolder.length === 0)) || isSubmitting}>
        {isSubmitting ? (
          <>
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            Starting Screening...
          </>
        ) : (
          "Start Screening"
        )}
      </Button>
    </form>
  );
}

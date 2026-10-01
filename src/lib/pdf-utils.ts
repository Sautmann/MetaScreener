import { Paper, PDFData } from "@/types";
import { PDFDocumentProxy } from "pdfjs-dist/types/src/display/api";
import pdfjsLib from "./pdfjs";


/**
 * Utility functions for handling PDF files and matching them to CSV entries
 * Uses SequenceMatcher-like algorithm for title matching and exact DOI matching
 * Powered by PDF.js for actual PDF processing
 */

/**
 * Calculate similarity ratio between two strings using longest common subsequence
 * Similar to Python's SequenceMatcher.ratio()
 */
function sequenceMatcherRatio(str1: string, str2: string): number {
    if (!str1 || !str2) return 0;

    const s1 = str1.toLowerCase();
    const s2 = str2.toLowerCase();

    if (s1 === s2) return 1.0;

    // Longest Common Subsequence, keeping only two rows of the DP table
    const m = s1.length;
    const n = s2.length;
    let prev = new Uint16Array(n + 1);
    let curr = new Uint16Array(n + 1);

    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            if (s1[i - 1] === s2[j - 1]) {
                curr[j] = prev[j - 1] + 1;
            } else {
                curr[j] = Math.max(prev[j], curr[j - 1]);
            }
        }
        [prev, curr] = [curr, prev];
    }

    const matches = prev[n];
    return (2.0 * matches) / (m + n);
}

/**
 * Extract metadata from a PDF file name
 * Common patterns: "title_author_year.pdf", "doi_paper.pdf", etc.
 */
export function extractMetadataFromFilename(filename: string): {
    title?: string;
    authors?: string;
    year?: string;
    doi?: string;
} {
    const cleanName = filename.replace(/\.pdf$/i, '');

    // Try to extract DOI pattern
    const doiMatch = cleanName.match(/^10.\d{4,9}\/[-._;()/:A-Z0-9]+$/i);
    if (doiMatch) {
        return { doi: doiMatch[0] };
    }

    // Try to extract year
    const yearMatch = cleanName.match(/(\d{4})/);
    const year = yearMatch ? yearMatch[1] : undefined;

    // Split by common delimiters and try to identify parts
    const parts = cleanName.split(/[_\-\s]+/);

    return {
        title: parts[0] ? parts[0].toLowerCase() : undefined,
        authors: parts[1] ? parts[1].toLowerCase() : undefined,
        year,
    };
}

/**
 * Calculate similarity score between two strings
 * Uses the same algorithm as sequenceMatcherRatio for consistency
 */
export function calculateSimilarity(str1: string, str2: string): number {
    return sequenceMatcherRatio(str1, str2);
}

export async function extractPdfData(file: File): Promise<PDFData> {
    const metadata = {
        title: '',
        authors: '',
        year: '',
        doi: ''
    };
    const arrayBuffer = await file.arrayBuffer();

    // Use PDF.js to extract metadata from the PDF file
    const loadingTask = pdfjsLib.getDocument(arrayBuffer);
    let pdf: PDFDocumentProxy;

    try {
        pdf = await loadingTask.promise;
        const pdfMetadata = await getMetaData(pdf);
        const fileName = file.name.replace(/\.pdf$/i, '');
        const firstPage = await pdf.getPage(1);
        // look for doi in the first page text
        const textContent = await firstPage.getTextContent();
        // extract doi from first page text if not in metadata
        if (!pdfMetadata.doi) {
            const fullText = textContent.items.map((item: any) => item.str).join(' ');
            const doi = await findDoiInText(fullText);
            if (doi) {
                pdfMetadata.doi = doi;
            }
        }
        metadata.title = pdfMetadata.title || fileName;
        const result = { ...metadata, ...pdfMetadata, filename: fileName, fulltext: await extractFullText(pdf) };

        // Clean up the PDF document to free memory and workers
        pdf.destroy();

        return result;
    } catch (error) {
        // Clean up on error
        if (pdf!) {
            pdf.destroy();
        }
        throw error;
    }
}

async function findDoiInText(text: string): Promise<string | undefined> {
    const doiRegex = /10\.\d{4,9}\/[-._;()/:A-Z0-9]+/i;
    const match = text.match(doiRegex);
    // Trailing punctuation is almost always sentence/bracket context, not part of the DOI
    return match ? match[0].replace(/[.,;:)]+$/, '') : undefined;
}


export async function getMetaData(pdf: PDFDocumentProxy) {
    const metadata = await pdf.getMetadata();
    const info = metadata.info as any;
    return {
        title: info?.Title || '',
        authors: info?.Author || '',
        year: info?.CreationDate ? new Date(info.CreationDate).getFullYear().toString() : '',
        doi: info?.DOI || ''
    };
}
export async function extractFullText(pdf: PDFDocumentProxy): Promise<string> {
    let fullText = '';
    const numPages = pdf.numPages;
    for (let i = 1; i <= numPages; i++) {
        const page = await pdf.getPage(i);
        const textContent = await page.getTextContent();
        // Keep the PDF's own line breaks so headings (e.g. "References") stay on their own line
        const pageText = textContent.items
            .map((item: any) => item.str + (item.hasEOL ? '\n' : ' '))
            .join('')
            .replace(/[ \t]+\n/g, '\n');
        fullText += pageText + '\n';
    }

    return fullText.trim();
}

const REFERENCES_HEADING = /\n[ \t]*(?:\d+\.?[ \t]*)?(references|bibliography|works cited|literature cited|reference list)[ \t]*\n/gi;
const POST_REFERENCES_HEADING = /\n[ \t]*(?:[A-Z]\.?[ \t]*)?(appendix|appendices|online appendix|supplementary (?:material|information|appendix)|annex)\b[^\n]{0,80}\n/i;

/**
 * Remove the reference list from extracted full text to save tokens.
 * Only cuts a "References"-style heading found in the second half of the document,
 * and keeps any appendix that follows it.
 */
export function stripReferences(text: string): string {
    if (!text) return text;
    let cut = -1;
    for (const match of text.matchAll(REFERENCES_HEADING)) {
        if (match.index !== undefined && match.index > text.length * 0.5) {
            cut = match.index;
        }
    }
    if (cut < 0) return text;

    const afterRefs = text.slice(cut + 1);
    const appendix = afterRefs.search(POST_REFERENCES_HEADING);
    const kept = text.slice(0, cut);
    return appendix >= 0 ? kept + '\n' + afterRefs.slice(appendix) : kept;
}

/** Rough token estimate (~4 characters per token for English text) */
export function estimateTokens(text: string | undefined): number {
    return text ? Math.ceil(text.length / 4) : 0;
}

/**
 * Extract PDF data from multiple files sequentially to avoid worker overload
 * Processes files one at a time with optional progress callback
 */
export async function extractPdfDataBatch(
    files: File[],
    onProgress?: (current: number, total: number, fileName: string) => void
): Promise<Array<PDFData>> {
    const results: Array<PDFData> = [];

    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        onProgress?.(i + 1, files.length, file.name);

        try {
            const pdfData = await extractPdfData(file);
            console.log(`Extracted data for ${file.name}:`, pdfData);
            results.push(pdfData);
        } catch (error) {
            console.error(`Error processing ${file.name}:`, error);
            // Add a placeholder entry with just the filename for failed files
            results.push({
                filename: file.name.replace(/\.pdf$/i, ''),
                title: file.name.replace(/\.pdf$/i, ''),
                authors: '',
                year: '',
                doi: '',
                fulltext: ''
            });
        }
    }

    return results;
}

/**
 * Interface for PDF matching results - memory efficient version using indices
 */
export interface PDFMatch {
    pdfIndex: number;  // Index into the original pdfDataList array
    paperIndex: number; // Index into the original papers array
    confidence: number;
    matchType: 'doi' | 'title' | 'filename';
}

/**
 * Normalize strings for better matching by removing common variations
 */
function normalizeForMatching(str: string): string {
    if (!str) return '';

    return str
        .toLowerCase()
        .trim()
        // Remove common punctuation and special characters
        .replace(/[^\w\s]/g, ' ')
        // Remove extra whitespace
        .replace(/\s+/g, ' ')
        // Remove common words that don't help with matching
        .replace(/\b(the|a|an|and|or|of|in|on|at|to|for|with|by)\b/g, ' ')
        // Remove extra spaces again
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Canonical DOI form used for exact matching: lowercase, URL/"doi:" prefixes removed,
 * and every run of non-alphanumerics collapsed to "_". This makes "10.1016/j.x.2020.1"
 * equal to a filename like "10_1016_j_x_2020_1" (as written by the PDF downloader).
 */
export function canonicalDoi(doi: string | undefined): string {
    if (!doi) return '';
    let s = doi;
    try {
        s = decodeURIComponent(s);
    } catch {
        // keep as-is if it is not valid URI encoding
    }
    s = s
        .toLowerCase()
        .trim()
        .replace(/^(https?:\/\/(dx\.)?doi\.org\/|doi:\s*)/, '')
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
    return /^10_\d{4,9}_./.test(s) ? s : '';
}

/**
 * Find a DOI encoded in a filename, e.g. "10_1016_j_jdeveco_2020_102345",
 * "10.1016_j.jdeveco.2020.102345" or "doi_10_1016_...". Returns the canonical form.
 */
export function doiFromFilename(filename: string | undefined): string {
    if (!filename) return '';
    let s = filename.replace(/\.pdf$/i, '');
    try {
        s = decodeURIComponent(s);
    } catch {
        // keep as-is
    }
    const canon = s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    const match = canon.match(/(?:^|_)(10_\d{4,9}_.+)$/);
    return match ? match[1] : '';
}

const CHAR_SLOTS = 128;

function charProfile(str: string): Uint16Array {
    const counts = new Uint16Array(CHAR_SLOTS);
    for (let i = 0; i < str.length; i++) {
        counts[str.charCodeAt(i) & (CHAR_SLOTS - 1)]++;
    }
    return counts;
}

/** Cheap upper bound on sequenceMatcherRatio (like SequenceMatcher.quick_ratio) */
function quickRatio(a: Uint16Array, aLen: number, b: Uint16Array, bLen: number): number {
    if (aLen + bLen === 0) return 0;
    let common = 0;
    for (let i = 0; i < CHAR_SLOTS; i++) {
        common += Math.min(a[i], b[i]);
    }
    return (2.0 * common) / (aLen + bLen);
}

function titleWords(normalized: string): Set<string> {
    return new Set(normalized.split(/[\s_]+/).filter(w => w.length >= 3));
}

const TITLE_THRESHOLD = 0.6;
// Titles that clear the character-level thresholds share a good part of their words;
// pairs below this word overlap are skipped without running the LCS.
const MIN_WORD_DICE = 0.4;
const FILENAME_THRESHOLD = 0.5;

/**
 * Match PDF files to papers without blocking the UI.
 * 1. Exact DOI match (PDF metadata / first-page DOI, or a DOI encoded in the filename)
 * 2. Fuzzy match of PDF title and filename against the paper title (best of the two)
 * Each PDF and each paper is used at most once; highest-confidence pairs win.
 */
export async function matchPdfsToPapersAsync(
    pdfDataList: PDFData[],
    papers: Paper[],
    minConfidence: number = 0.5,
    onProgress?: (current: number, total: number, pdfName: string) => void
): Promise<PDFMatch[]> {
    // Yield to the event loop by elapsed time rather than per comparison count
    let lastYield = performance.now();
    const maybeYield = async () => {
        if (performance.now() - lastYield > 30) {
            await new Promise(resolve => setTimeout(resolve, 0));
            lastYield = performance.now();
        }
    };

    // Precompute per-paper lookup data once
    const doiIndex = new Map<string, number[]>();
    const wordIndex = new Map<string, number[]>();
    const paperTitles = papers.map((paper, paperIndex) => {
        const doi = canonicalDoi(paper.doi);
        if (doi) {
            const list = doiIndex.get(doi) ?? [];
            list.push(paperIndex);
            doiIndex.set(doi, list);
        }
        const title = normalizeForMatching(paper.title);
        const words = titleWords(title);
        for (const word of words) {
            const list = wordIndex.get(word) ?? [];
            list.push(paperIndex);
            wordIndex.set(word, list);
        }
        return { title, profile: charProfile(title), wordCount: words.size };
    });
    const allPaperIndices = papers.map((_, i) => i);

    const potentialMatches: Array<{
        pdfIndex: number;
        paperIndex: number;
        score: number;
        matchType: 'doi' | 'title' | 'filename';
    }> = [];

    for (let pdfIndex = 0; pdfIndex < pdfDataList.length; pdfIndex++) {
        const pdfData = pdfDataList[pdfIndex];

        // 1. Exact DOI matches
        const pdfDois = new Set(
            [canonicalDoi(pdfData.doi), doiFromFilename(pdfData.filename)].filter(Boolean)
        );
        let doiMatched = false;
        for (const doi of pdfDois) {
            for (const paperIndex of doiIndex.get(doi) ?? []) {
                potentialMatches.push({ pdfIndex, paperIndex, score: 1.0, matchType: 'doi' });
                doiMatched = true;
            }
        }

        // 2. Fuzzy title / filename matching
        if (!doiMatched) {
            const pdfTitle = normalizeForMatching(pdfData.title || '');
            const pdfFilename = normalizeForMatching(pdfData.filename || '');
            const candidates = [
                { text: pdfTitle, threshold: TITLE_THRESHOLD, matchType: 'title' as const },
                { text: pdfFilename, threshold: FILENAME_THRESHOLD, matchType: 'filename' as const },
            ]
                .filter(c => c.text)
                .map(c => ({
                    ...c,
                    threshold: Math.max(c.threshold, minConfidence),
                    profile: charProfile(c.text),
                    words: titleWords(c.text),
                }));

            // Shared-word counts per paper for each candidate text, via the inverted index.
            // Texts with fewer than 3 words (e.g. "CashTransfersKenya2020") get a full scan instead.
            let needsFullScan = false;
            const sharedWords = candidates.map(c => {
                if (c.words.size < 3) {
                    needsFullScan = true;
                    return null;
                }
                const counts = new Map<number, number>();
                for (const word of c.words) {
                    for (const paperIndex of wordIndex.get(word) ?? []) {
                        counts.set(paperIndex, (counts.get(paperIndex) ?? 0) + 1);
                    }
                }
                return counts;
            });
            const paperIndicesToCheck = needsFullScan
                ? allPaperIndices
                : [...new Set(sharedWords.flatMap(counts => [...(counts?.keys() ?? [])]))];

            let checked = 0;
            for (const paperIndex of paperIndicesToCheck) {
                const paperTitle = paperTitles[paperIndex];
                if (!paperTitle.title) continue;

                let best: { score: number; matchType: 'title' | 'filename' } | null = null;
                for (let ci = 0; ci < candidates.length; ci++) {
                    const c = candidates[ci];
                    const counts = sharedWords[ci];
                    if (counts) {
                        const dice = (2 * (counts.get(paperIndex) ?? 0)) / (c.words.size + paperTitle.wordCount);
                        if (dice < MIN_WORD_DICE) continue;
                    }
                    // Skip the expensive LCS when even the upper bound can't beat the threshold
                    const bound = quickRatio(c.profile, c.text.length, paperTitle.profile, paperTitle.title.length);
                    if (bound <= c.threshold || (best && bound <= best.score)) continue;
                    const score = sequenceMatcherRatio(c.text, paperTitle.title);
                    if (score > c.threshold && (!best || score > best.score)) {
                        best = { score, matchType: c.matchType };
                    }
                }
                if (best) {
                    potentialMatches.push({ pdfIndex, paperIndex, ...best });
                }
                if (++checked % 500 === 0) {
                    await maybeYield();
                }
            }
        }

        onProgress?.(pdfIndex + 1, pdfDataList.length, pdfData?.filename || `PDF ${pdfIndex + 1}`);
        await maybeYield();
    }

    // Sort by confidence (highest first)
    potentialMatches.sort((a, b) => b.score - a.score);

    // Select best non-conflicting matches
    const matches: PDFMatch[] = [];
    const usedPdfIndices = new Set<number>();
    const usedPaperIndices = new Set<number>();

    for (const potentialMatch of potentialMatches) {
        if (!usedPdfIndices.has(potentialMatch.pdfIndex) &&
            !usedPaperIndices.has(potentialMatch.paperIndex)) {

            matches.push({
                pdfIndex: potentialMatch.pdfIndex,
                paperIndex: potentialMatch.paperIndex,
                confidence: potentialMatch.score,
                matchType: potentialMatch.matchType
            });

            usedPdfIndices.add(potentialMatch.pdfIndex);
            usedPaperIndices.add(potentialMatch.paperIndex);
        }
    }

    return matches;
}


/**
 * Helper function to get the actual PDF and Paper objects from a match
 * Use this when you need to access the actual data
 */
export function getMatchData(
    match: PDFMatch,
    pdfDataList: PDFData[],
    papers: Paper[]
): { pdfData: PDFData; paper: Paper } {
    return {
        pdfData: pdfDataList[match.pdfIndex],
        paper: papers[match.paperIndex]
    };
}

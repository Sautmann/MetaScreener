# Meta-Screener Tool

> [!IMPORTANT]  
> This repository contains the current and future state of the Meta-Screen tool developed by Shrenik Borad, Jonas Weinert, Anja Sautmann, Adisiri Swain as part of a meta-analysis automation exercise. It is a port from [this now deprecated repository](https://github.com/IDEAL-consortium/ideal-extract). For previous development and contribution history, review the above. For contributions and the most up to date version, refer to this repository at hand.

## Citation

Use of this software must be cited as:

**Sautmann, A., Weinert, J., Swain, A., & Borad, S.** *Meta-screener.* https://github.com/Sautmann/MetaScreener

See [LICENSE.md](LICENSE.md) for full terms. Where the licensor is an intergovernmental organization (IGO), the additional procedural terms in [WB-IGO-RIDER.md](WB-IGO-RIDER.md) apply.

---

## Overview

The Meta-screener tools support two modes of operation: **Full Text** and **Title & Abstract**. This tool is designed to help you screen articles based on criteria efficiently.

---

## Input Requirements

### 1. OpenAI API Key
  - In Settings add the OpenAI API Key

### 2. CSV File

- **Required Columns:**  
  - `Title`
  - `Abstract`
  - `DOI`

### 3. Custom Fields

- **Name:**  
  - Use a unique, space-free string as the identifier.
- **Instruction:**  
  - Provide a question to ask about each research paper, expecting a **Yes/No/Maybe** answer.

---

## Output Options

Users can select any combination of the following output fields:

- **Method**
- **Design**
- **All custom fields**
  - Each field also include a probablity score (calculated from underlying logprobs of the tokens)
- **Perplexity Score:**  
  - Indicates how well a probabilistic language model predicts the text.  
  - Values closer to 1 indicate better model confidence.

---

## Full Text Mode

1. Place all relevant PDFs in a folder.
2. The tool matches PDFs to CSV rows using:
   - DOI in the PDF metadata or on the first page
   - A DOI used as the filename, with dots and slashes replaced (e.g. `10_1016_j_jdeveco_2020_102345.pdf`, as saved by the PDF Download page)
   - Title in the PDF metadata, or the filename, compared with the paper title
   - If some PDFs are not matched, rename them to the paper's DOI or title.
3. What the model receives depends on the processing mode (below): text extracted from the PDF (Batch), or the PDF file itself (Synchronous).

---

## Processing Modes: Batch and Synchronous

|  | Batch | Synchronous |
|---|---|---|
| Price | About 50% cheaper | Standard API price |
| Speed | Within 24 hours | Minutes; results arrive per paper |
| Browser | Can be closed after starting | Tab must stay open while running |
| Full text sent as | Text extracted from the PDF | The PDF file (OpenAI reads its text **and** page images) |
| Scanned PDFs | Skipped | Screened from the page images |

Use **Batch** for large or cost-sensitive runs. Use **Synchronous** for full-text screening where layout matters (tables, symbols such as ≥ ± <, multi-column pages, article-type labels, scanned papers) and for quick pilots. Full-text PDF input needs a model that accepts images (GPT-4o, GPT-4.1, GPT-5 or later) and uses roughly 2–4× more input tokens.

### Running a synchronous job

1. On **Screen Fields**, pick the screening mode and model(s), then under **Processing** choose **Synchronous**.
2. Enter your OpenAI **requests per minute** and **tokens per minute** limits for that model, from [platform.openai.com → Settings → Limits](https://platform.openai.com/settings/organization/limits). Lower values are safe, just slower. With a TPM limit below ~50,000, use 1–2 parallel requests.
3. Upload the CSV (and PDF folder), check the matching panel's token and time estimate, and start the job.
4. Keep the tab open. Progress, failures and results are visible in **Job Management**; results can be downloaded at any time.

### Rate limits and errors

- Requests are paced to stay under your RPM/TPM limits, and token estimates are corrected from the usage OpenAI reports.
- On a rate-limit response (429) all requests for that model pause and retry; the paper is not marked as failed.
- Server and network errors are retried with back-off.
- Out of credit or an invalid API key stops the job with a message; fix it and click **Resume**.
- Papers that fail individually (e.g. PDF over 50 MB) can be re-run with **Retry failed** once the job finishes.
- If the tab is closed or reloaded, the job shows as *Interrupted*; **Resume** continues with the remaining papers only.

In synchronous full-text mode the PDFs are sent to OpenAI and kept in the browser's IndexedDB until the job is deleted.


## Development Setup

To start the development server:

```bash
npm install
npm run dev
```

This will install dependencies and launch the local server for testing and development.

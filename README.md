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
   - Title and DOI in PDF metadata
   - Filename
   - DOI found on the first page of the PDF using basic regex
   - If you find that some pdfs are not matched try changing there name to title of the paper. This will help the code to match the file to row in csv
3. Extracted PDF text is supplied as context to the AI model for classification.


## Development Setup

To start the development server:

```bash
npm install
npm run dev
```

This will install dependencies and launch the local server for testing and development.

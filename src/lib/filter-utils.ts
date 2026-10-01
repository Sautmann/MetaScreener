import { CustomField, Paper } from "@/types";
import { nameToKey } from "./openai-service";
type PaperWithFields = Paper & Record<string, string>

export function hasRecheckOptions(field: CustomField): boolean {
    return !!(field.force_recheck || field.recheck_yes || field.recheck_no);
}

/**
 * Decide whether a paper should be (re)screened, based on answers from a previous run
 * that are present as columns in the uploaded CSV.
 *
 * - If no field has recheck options set, every paper is included.
 * - Otherwise a paper is included if, for any field with recheck options:
 *   - force_recheck is set, or
 *   - the previous answer is missing or not a definite yes/no (e.g. "maybe"), or
 *   - recheck_yes is set and the previous answer was "yes", or
 *   - recheck_no is set and the previous answer was "no".
 *
 * Column names are compared via nameToKey, so a "Has Control Group" column written by a
 * previous export matches the "Has Control Group" field.
 */
export function isPaperIncluded(paper: PaperWithFields, customFields: Array<CustomField> = []): boolean {
    const recheckFields = customFields.filter(hasRecheckOptions);
    if (recheckFields.length === 0) {
        return true;
    }

    const previousAnswers = new Map<string, string>();
    for (const [column, value] of Object.entries(paper)) {
        previousAnswers.set(nameToKey(column), String(value ?? ""));
    }

    for (const field of recheckFields) {
        if (field.force_recheck) {
            return true;
        }
        const previous = (previousAnswers.get(nameToKey(field.name)) ?? "")
            .trim()
            .toLowerCase()
            .replace(/[^a-z]/g, "");
        if (previous !== "yes" && previous !== "no") {
            // not screened yet, or undecided ("maybe") -> screen it
            return true;
        }
        if (field.recheck_yes && previous === "yes") {
            return true;
        }
        if (field.recheck_no && previous === "no") {
            return true;
        }
    }

    return false;
}

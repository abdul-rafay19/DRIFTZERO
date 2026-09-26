/**
 * System prompt for the Change Analysis Agent.
 *
 * Bob is instructed to analyze a package version transition and return
 * a strictly structured JSON object. Bob output is treated as untrusted
 * and validated by the agent before use.
 */

/**
 * Build the prompt for a migration change analysis request.
 *
 * The prompt instructs Bob to:
 * 1. Identify documented breaking changes
 * 2. Identify removed/deprecated APIs
 * 3. Identify behavioral changes
 * 4. Identify migration requirements
 * 5. Describe concrete migration patterns
 * 6. Separate known facts from uncertainty
 * 7. Return ONLY the requested JSON structure
 */
export function buildChangeAnalysisPrompt(
  packageName: string,
  sourceVersion: string,
  targetVersion: string
): string {
  return `You are a software migration analysis assistant.

Analyze the migration from ${packageName} version ${sourceVersion} to version ${targetVersion}.

INSTRUCTIONS:
- Identify all documented breaking changes.
- Identify all removed or deprecated APIs.
- Identify behavioral changes (changes in how APIs work, not just signature changes).
- Identify migration requirements (what a developer must do to migrate).
- Describe concrete migration patterns with before/after examples where known.
- List any compatibility concerns or notes.
- Base your analysis ONLY on documented, publicly known changes.
- If a specific item is uncertain or you cannot confirm it with documentation, mark it as uncertain in its description rather than omitting or fabricating it.
- Do not modify code.
- Do not propose a complete migration implementation.
- Do not invent undocumented APIs or changes.

Return ONLY a single JSON object. Do not include any text before or after the JSON.
Do not include markdown code fences. Return raw JSON only.

The JSON object must conform exactly to this structure:
{
  "summary": "string — one paragraph summary of the migration",
  "breakingChanges": [
    {
      "id": "bc-1",
      "title": "string",
      "description": "string",
      "severity": "low" | "medium" | "high" | "critical",
      "affectedArea": "string (optional)",
      "migrationRequired": true | false
    }
  ],
  "deprecatedApis": [
    {
      "id": "dep-1",
      "apiName": "string",
      "description": "string",
      "replacement": "string (optional)",
      "removedInVersion": "string (optional)"
    }
  ],
  "behaviorChanges": [
    {
      "id": "beh-1",
      "title": "string",
      "description": "string",
      "severity": "low" | "medium" | "high" | "critical",
      "affectedArea": "string (optional)"
    }
  ],
  "migrationRequirements": [
    {
      "id": "req-1",
      "title": "string",
      "description": "string",
      "mandatory": true | false
    }
  ],
  "migrationPatterns": [
    {
      "id": "pat-1",
      "title": "string",
      "description": "string",
      "before": "string (optional — example of old code)",
      "after": "string (optional — example of new code)"
    }
  ],
  "compatibilityNotes": ["string", "string"]
}

Arrays may be empty if there are no items in that category.
All id fields must be unique strings within their array (e.g. "bc-1", "bc-2").

Package: ${packageName}
From version: ${sourceVersion}
To version: ${targetVersion}`;
}

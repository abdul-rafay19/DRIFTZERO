# DriftZero — Product Specification

## Overview

DriftZero is an Autonomous SDK/API Migration Platform. It analyzes a target repository, plans a migration between SDK/API versions, executes the migration using AI, validates correctness, and creates a pull request — without manual intervention.

## Initial Target

**Express.js 4 → Express.js 5**

## AI Provider

**IBM Bob** is the sole AI provider for DriftZero.

- All LLM intelligence flows through IBM Bob.
- No other AI provider is used or planned.
- IBM Bob integration is implemented in Phase 2.

## Lifecycle Stages

Every migration job passes through the following locked lifecycle:

| Stage | Description |
|-------|-------------|
| PENDING | Job created, not yet started |
| ANALYZING | Codebase analysis |
| IMPACT_ANALYSIS | Identify all affected files and call sites |
| RISK_ASSESSMENT | Classify migration risk |
| PREVIEW | Generate preview of required changes |
| PLANNING | Build migration execution plan |
| MIGRATING | Apply code transformations |
| TEST_GENERATION | Generate tests for migrated code |
| VALIDATING | Run test suite, verify correctness |
| RECOVERING | Auto-recover from validation failures |
| REVALIDATING | Re-run validation after recovery |
| CHANGE_VERIFICATION | Verify all required changes were applied |
| SECURITY_REVIEW | Scan for security issues introduced |
| SAFETY_GATE | Final safety check before commit |
| DIFF_INTELLIGENCE | AI-powered diff analysis |
| CONFIDENCE | Compute confidence score |
| VERIFIED | Migration verified |
| COMMIT | Commit changes to branch |
| PUSH | Push branch to remote |
| CREATE_PR | Create pull request |
| REPORT | Generate migration report |
| COMPLETED | Migration complete |

## Migration Status

| Status | Description |
|--------|-------------|
| PENDING | Job created, not started |
| RUNNING | Migration in progress |
| COMPLETED | Migration succeeded |
| FAILED | Migration failed |
| STOPPED | Migration manually stopped |
| UNSAFE | Migration halted by safety gate |

## Security

- `BOB_API_KEY` is a backend-only secret — never exposed to the browser.
- No migration is executed without passing the SAFETY_GATE stage.
- Stack traces and internal errors are never returned to clients.

## Roadmap

| Phase | Description |
|-------|-------------|
| Phase 1 | Repository foundation |
| Phase 2 | IBM Bob AI integration |
| Phase 3 | Migration engine |
| Phase 4 | GitHub integration & PR creation |
| Phase 5 | Advanced dashboard & diff viewer |

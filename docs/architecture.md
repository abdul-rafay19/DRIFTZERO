# DriftZero — Architecture

## System Overview

```
Browser (Next.js)
       ↓  NEXT_PUBLIC_API_URL (HTTP)
Express 5 Backend
       ↓  BOB_API_KEY (Phase 2+)
IBM Bob AI
```

## Monorepo Structure

```
driftzero/
├── shared/     @driftzero/shared — types, constants, errors
├── backend/    Express 5 API server
└── frontend/   Next.js 16 App Router
```

## Package Responsibilities

### `@driftzero/shared`

- TypeScript types shared across all packages
- Shared constants (`APP_NAME`, `SUPPORTED_MIGRATIONS`, timeouts)
- Error classes (`DriftZeroError`, `ValidationError`, `NotFoundError`, `ProviderError`)
- No runtime dependencies
- Never imports from backend or frontend

### Backend

- Express 5 API server (ES Modules, NodeNext)
- Owns all business logic
- Consumes `@driftzero/shared`
- IBM Bob client will live here (Phase 2)
- Migration engine will live here (Phase 3)

### Frontend

- Next.js 16 App Router, TypeScript
- Presentation layer only — no business logic
- Consumes `@driftzero/shared` for types
- Communicates with backend via `NEXT_PUBLIC_API_URL`
- Never imports backend code

## Phase 1 Backend Routes

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/health | Health check |
| POST | /api/migrations | Create migration job |
| GET | /api/migrations | List all jobs |
| GET | /api/migrations/:jobId | Get specific job |

## Environment Variables

| Variable | Location | Purpose |
|----------|----------|---------|
| PORT | backend | Server port |
| NODE_ENV | backend | Environment |
| FRONTEND_URL | backend | CORS origin |
| BOB_API_KEY | backend | IBM Bob API key (Phase 2+) |
| NEXT_PUBLIC_API_URL | frontend | Backend API base URL |

## Security Architecture

- `BOB_API_KEY` is backend-only — never prefixed `NEXT_PUBLIC_`
- CORS is restricted to `FRONTEND_URL` (no wildcard `*`)
- Error handler never leaks stack traces, paths, or secrets to clients
- `.env` and `.env.local` are git-ignored
- `.env.example` tracks safe placeholder values

## AI Architecture (Phase 2+)

```
Migration Agents
       ↓
IBM Bob Client
       ↓
IBM Bob API
```

DriftZero uses **IBM Bob as its sole AI provider**. There is no multi-provider abstraction, no model router, and no provider fallback mechanism.

# DriftZero

**Autonomous SDK/API Migration Platform**

DriftZero is an AI-powered platform that autonomously migrates codebases between SDK and API versions. It analyzes, plans, executes, validates, and creates pull requests for migrations — without manual intervention.

**Planned AI provider: IBM Bob (sole provider).**  
IBM Bob integration is **not yet implemented** — it belongs to Phase 2.

---

## Current Scope — Phase 1: Repository Foundation

Phase 1 establishes the monorepo foundation. There is **no migration execution, no AI integration, and no database** in this phase. The goal is a clean, type-safe base that Phase 2 can build on.

### What is implemented

- pnpm workspace monorepo
- TypeScript (strict, ES2022)
- Next.js 16 frontend (App Router)
- Express 5 backend (ES Modules)
- Shared types, constants, and error classes (`@driftzero/shared`)
- Environment configuration
- Basic structured logger
- Centralized error handling middleware
- `GET /api/health` endpoint
- Migration job API skeleton (in-memory, no execution)
- Frontend → Backend health communication
- Git configuration

### What is NOT implemented

- IBM Bob / AI integration
- Migration execution or analysis
- Database or queue system
- Authentication
- GitHub integration
- Dashboard / diff viewer / timeline
- Any Phase 2+ functionality

---

## Repository Structure

```
driftzero/
├── .env.example              # Environment variable template
├── .gitignore
├── package.json              # Root workspace scripts
├── pnpm-workspace.yaml
├── tsconfig.base.json        # Shared TypeScript base config
├── README.md
│
├── shared/                   # @driftzero/shared
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts
│       ├── types.ts          # MigrationJob, HealthResponse, etc.
│       ├── constants.ts      # APP_NAME, SUPPORTED_MIGRATIONS, etc.
│       └── errors.ts         # DriftZeroError, ValidationError, etc.
│
├── backend/                  # Express 5 API server
│   ├── .env                  # Local dev config (git-ignored)
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts          # Server entry point
│       ├── middleware/
│       │   └── errorHandler.ts
│       ├── routes/
│       │   ├── health.ts     # GET /api/health
│       │   └── migrations.ts # POST/GET /api/migrations
│       └── utils/
│           └── logger.ts
│
└── frontend/                 # Next.js 16 App Router
    ├── .env.local            # Local frontend env (git-ignored)
    ├── package.json
    ├── tsconfig.json
    ├── next.config.ts
    └── src/app/
        ├── layout.tsx
        ├── page.tsx          # Backend health check page
        └── globals.css
```

---

## Prerequisites

- Node.js 20+
- pnpm 9+

---

## Getting Started

### Install dependencies

```bash
pnpm install
```

### Configure environment

Copy the example and fill in values:

```bash
cp .env.example backend/.env
```

Required for Phase 1 (defaults work out of the box):

```
PORT=4000
NODE_ENV=development
FRONTEND_URL=http://localhost:3000
```

For the frontend:

```bash
echo "NEXT_PUBLIC_API_URL=http://localhost:4000" > frontend/.env.local
```

### Development

Run both backend and frontend in parallel:

```bash
pnpm dev
```

Or run individually:

```bash
pnpm dev:backend   # Express backend on port 4000
pnpm dev:frontend  # Next.js frontend on port 3000
```

### Type checking

```bash
pnpm typecheck
```

### Build

```bash
pnpm build
```

---

## Ports

| Service  | Port |
|----------|------|
| Backend  | 4000 |
| Frontend | 3000 |

---

## API Reference

### Health

```
GET /api/health
```

Response `200`:
```json
{
  "success": true,
  "data": {
    "status": "ok",
    "uptime": 12.34,
    "version": "0.1.0",
    "timestamp": "2024-01-01T00:00:00.000Z"
  }
}
```

### Migration Jobs (skeleton — no execution)

#### Create job

```
POST /api/migrations
Content-Type: application/json

{
  "repoUrl": "https://github.com/example/repo",
  "sourceVersion": "express@4",
  "targetVersion": "express@5"
}
```

Response `201`:
```json
{
  "success": true,
  "data": {
    "id": "mig_abc123def456",
    "repoUrl": "https://github.com/example/repo",
    "sourceVersion": "express@4",
    "targetVersion": "express@5",
    "status": "PENDING",
    "currentStage": "PENDING",
    "progress": 0,
    "createdAt": "...",
    "updatedAt": "..."
  }
}
```

#### List jobs

```
GET /api/migrations
```

#### Get job

```
GET /api/migrations/:jobId
```

---

## IBM Bob — AI Provider

DriftZero's sole AI provider is **IBM Bob**.

- BOB_API_KEY is a **backend-only** secret.
- It is **never** exposed to the browser or frontend environment.
- IBM Bob integration will be implemented in **Phase 2**.

---

## Current Limitations

- Migration jobs are stored **in memory** only — they are lost on server restart.
- No migration execution occurs — creating a job only stores the record.
- No authentication is implemented.
- IBM Bob is not yet integrated.
- The frontend only displays a backend health check.

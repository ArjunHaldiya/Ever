# EVER

> **"When the power goes out, the map still says the pharmacy is open. It isn't."**

EVER is an AI-powered help line that keeps working during power outages. People text one number, describe what they need in plain language, and get routed to the nearest **open, powered** resource — pharmacy, cooling center, food site, or charging station. Before a planned utility shutoff, it warns opted-in residents with power-dependent needs and tracks how many received the message. If the AI fails for any reason, the system continues answering in a deterministic degraded mode and never loses a request.

Built for SpartHill Hacks 2026 (SJSU × Foothill), Track 05: AI-Driven Automation & Critical Service Continuity (AWS).

---

## Table of Contents

- [Features](#features)
- [Architecture](#architecture)
- [Repo Structure](#repo-structure)
- [Tech Stack](#tech-stack)
- [Prerequisites](#prerequisites)
- [Getting Started](#getting-started)
- [Environment Variables](#environment-variables)
- [Commands](#commands)
- [Deployment](#deployment)
- [Data Model](#data-model)
- [Privacy and Safety](#privacy-and-safety)

---

## Features

- **AI triage via SMS/iMessage** — texts are parsed by AWS Bedrock (Converse API with tool use) into a structured need: type, tier, location, language, and an emergency flag
- **Emergency detection first** — phrases like "chest pain", "can't breathe", "no puedo respirar" trigger an immediate "Call 911" reply before any AI runs
- **Deterministic matching** — resources are filtered by `hasPower`, open hours, capacity, and need type, then sorted by haversine distance; no AI is involved in the decision
- **Resilient degraded mode** — if Bedrock errors or takes > 4 seconds, the rules extractor (regex/keyword) takes over; replies always say when backup mode is active
- **Shutoff warnings** — a dashboard form sends pre-outage warnings to opted-in residents by ZIP and shows how many were reached
- **Live responder dashboard** — React + MapLibre map of active needs colored by tier, resource capacity, queue depth, and a chaos toggle for live demos
- **Queue-first, at-least-once** — every request flows through SQS; 3 failures → DLQ → visible on the dashboard; nothing is silently dropped

---

## Architecture

```
Resident phone ──iMessage──► Photon Spectrum ──► gateway (always-on Node, EC2)
                                                   │  verify · dedupe · enqueue
                                                   ▼
                                           SQS inbound (+ DLQ)
                                                   │
                                                   ▼
                                       worker Lambda (SQS trigger, batch=1)
                              ┌────────────────────┴────────────────────┐
                    ai_mode=primary                          ai_mode=degraded / error / >4s
                 Bedrock extractor (tool use)               rules extractor (regex/keywords)
                              └────────────────────┬────────────────────┘
                                                   ▼
                                  deterministic matcher (identical in both modes)
                                                   ▼
                              reply (Bedrock-phrased or template) → SQS outbound
                                                   ▼
                               gateway polls outbound SQS → Photon sends message
                                                   ▼
                            DynamoDB ◄──── dashboard API (Lambda) ◄──── dashboard (React)
```

**Key design rule: AI extracts, code decides.** The LLM only produces a structured `ExtractedNeed` (tier, needType, locationText, language, confidence). The matcher is pure deterministic TypeScript — same code runs in both AI and degraded mode. This is why failover is cheap and reliable.

**Why the gateway is not a Lambda:** Photon fires its webhook *after* the HTTP response is sent. A Lambda can freeze once it returns, so that work may never run. The gateway is an always-on Node.js process consuming Photon's message stream.

---

## Repo Structure

```
/
├── packages/
│   ├── core/       # All business logic: types, schemas, matcher, emergency check,
│   │               # rules extractor, pipeline, templates — pure functions, no AWS I/O
│   ├── gateway/    # Always-on Node service: Photon stream → dedupe → SQS inbound;
│   │               # outbound loop polls SQS outbound → Photon sends
│   ├── worker/     # Lambda handler: SQS trigger → extract → match → reply → DynamoDB
│   ├── api/        # Lambda + API Gateway: dashboard state, chaos toggle, shutoff trigger,
│   │               # resident management
│   └── dashboard/  # React + Vite + MapLibre frontend (polls API every 2s)
├── infra/          # AWS CDK app (single AppStack)
├── seed/           # resources.json, zip_centroids.json, demo_residents.json, seed script
├── scripts/        # Demo helpers: reset-demo, trigger-shutoff, toggle-chaos
├── .env.example    # Environment variable template
└── CLAUDE.md       # Full project spec, conventions, and build guide
```

---

## Tech Stack

| Layer | Choice |
|---|---|
| Language | TypeScript (strict), Node.js ≥ 20 |
| Monorepo | pnpm workspaces |
| Messaging | Photon `spectrum-ts` (iMessage); `terminal` provider for local dev |
| Gateway | Always-on Node.js on EC2 t3.small |
| Queue | AWS SQS standard + DLQ (`maxReceiveCount: 3`) |
| Worker | AWS Lambda (ARM64, Node 22, 512 MB, 30s timeout) |
| AI | AWS Bedrock Converse API with tool use (Haiku/Nova-class model) |
| Geocoding | AWS Location Service (Esri); ZIP centroid table as offline fallback |
| Chaos flag | AWS SSM Parameter Store (`/app/ai_mode = primary \| degraded`) |
| Secrets | AWS Secrets Manager |
| Database | AWS DynamoDB (on-demand) |
| Dashboard | React + Vite + MapLibre GL |
| Validation | zod on every external payload and every LLM output |
| Build | esbuild (Lambda bundles), tsx (scripts) |
| Tests | Vitest |
| Infrastructure | AWS CDK (TypeScript) |

---

## Prerequisites

- Node.js ≥ 20
- pnpm 10.33.2 (`corepack enable` or `npm install -g pnpm`)
- AWS CLI configured with credentials for your target account
- AWS CDK CLI: `npm install -g aws-cdk`
- (Optional) Photon Spectrum account for real iMessage integration

---

## Getting Started

```bash
# 1. Install dependencies
pnpm install

# 2. Configure environment
cp .env.example .env.local
# Fill in .env.local — see Environment Variables below

# 3. Run locally (no Photon or AWS needed — uses terminal provider)
pnpm dev:gateway      # gateway with terminal I/O
pnpm dev:dashboard    # React dashboard on Vite dev server

# 4. Run tests
pnpm test
```

---

## Environment Variables

Copy `.env.example` to `.env.local` (gitignored). **Never commit real values.**

| Variable | Description |
|---|---|
| `AWS_REGION` | AWS region (default: `us-east-1`) |
| `BEDROCK_MODEL_ID` | Bedrock model ID (e.g. a Haiku or Nova model). Empty → rules extractor only |
| `QUEUE_URL` | Inbound SQS queue URL (from CDK output `QueueUrl`) |
| `DLQ_URL` | Inbound DLQ URL (from CDK output `DlqUrl`) |
| `TABLE_PREFIX` | DynamoDB table name prefix (default: `app-`) |
| `AI_MODE_PARAM` | SSM parameter name for the chaos flag (default: `/app/ai_mode`) |
| `PHONE_HASH_SALT` | Salt for SHA-256 phone hashing (auto-generated in prod via Secrets Manager) |
| `SPECTRUM_PROJECT_ID` | Photon Spectrum project ID |
| `SPECTRUM_PROJECT_SECRET` | Photon Spectrum project secret |
| `SPECTRUM_WEBHOOK_SECRET` | Leave blank — the gateway reads Photon's stream, not webhooks |
| `LOCATION_PLACE_INDEX` | AWS Location Service place index name (from CDK output) |
| `DEMO_MODE` | `true` enables seeded data and cached demo replies |

Additional variables injected by CDK into Lambda environments:
`OUTBOUND_QUEUE_URL`, `OUTBOUND_DLQ_URL`, `PHONE_HASH_SALT_SECRET`, `API_KEY_SECRET`, `PHOTON_SECRET`, `WORKER_FUNCTION_NAME`

---

## Commands

```bash
pnpm install              # install all workspace dependencies

# Development
pnpm dev:gateway          # local gateway with terminal provider (no Photon)
pnpm dev:dashboard        # Vite dev server for the dashboard

# Testing & type checking
pnpm test                 # vitest (single run)
pnpm test:watch           # vitest in watch mode
pnpm typecheck            # tsc across all packages

# Build (Lambda bundles)
pnpm build:worker         # → dist/worker.zip
pnpm build:api            # → dist/api.zip
pnpm build:gateway        # → dist/gateway.mjs (ESM bundle for EC2)

# Seed and demo helpers
pnpm seed                 # load resources, ZIP centroids, and demo residents into DynamoDB
pnpm demo:reset           # restore capacities; clear needs and alerts tables
pnpm demo:shutoff 95112   # trigger a shutoff warning for ZIP 95112
pnpm demo:chaos on        # set ai_mode=degraded (chaos mode)
pnpm demo:chaos off       # set ai_mode=primary (restore AI)

# Infrastructure
pnpm cdk deploy           # deploy the AppStack to AWS
pnpm cdk diff             # preview infrastructure changes
```

---

## Deployment

The CDK app provisions everything in a single `AppStack`.

```bash
# 1. Deploy infrastructure
pnpm cdk deploy

# 2. Upload the gateway bundle to the S3 artifacts bucket (CDK output: GatewayArtifactsBucket)
pnpm build:gateway
aws s3 cp dist/gateway.mjs s3://<GatewayArtifactsBucket>/gateway.mjs

# 3. Fill in Photon credentials (never put these in the CDK template)
aws secretsmanager put-secret-value \
  --secret-id app/photon \
  --secret-string file://photon.json

# 4. On the EC2 gateway, run the update script via SSM Session Manager
#    (CDK output: GatewayInstanceId)
aws ssm start-session --target <GatewayInstanceId>
# then inside the session:
sudo ever-gateway-update

# 5. Seed demo data
pnpm seed
```

CDK context overrides (pass with `--context key=value`):

| Key | Default | Description |
|---|---|---|
| `tablePrefix` | `app-` | DynamoDB table name prefix |
| `aiModeParam` | `/app/ai_mode` | SSM parameter name for the chaos flag |
| `bedrockModelId` | (empty) | Bedrock model ID; overrides the env var |

> **Note:** all DynamoDB tables and S3 buckets use `RemovalPolicy.DESTROY`. Running `cdk destroy` deletes everything including stored data — intentional for this hackathon deployment.

---

## Data Model

| Table | Key | What's stored |
|---|---|---|
| `Resources` | `id` | Name, type, lat/lng, address, `hasPower`, capacity, hours, `supports[]` |
| `Needs` | `id` | Tier, needType, status, mode, extractor metadata, timestamps. **No text, location, ZIP, or matched place** |
| `Residents` | `phoneHash` | Hashed phone, ZIP, needType, `optedIn`, Photon user ID. Raw phone only while opted in |
| `Alerts` | `alertId` + `phoneHash` | Per-resident shutoff warning with sent/delivered/read timestamps |
| `Conversations` | `phoneHash` | Short-TTL state between "what's your ZIP?" and the resident's reply |
| `Processed` | `messageId` | 24-hour TTL deduplication for inbound message IDs |

---

## Privacy and Safety

- **No message text is ever stored.** Text, location, ZIP, and the matched place/distance are used to answer and then discarded.
- **Phone numbers are hashed** (SHA-256 + a never-rotated salt). Raw numbers are only stored for opted-in residents, and only while they remain opted in.
- **Emergency detection runs synchronously before any AI**, in English, Spanish, and Vietnamese. Any life-threatening phrase triggers an immediate "Call 911" reply.
- **Bedrock replies are validated** against the matcher's facts before sending. Any reply that omits the place name, invents a phone number, or contains medical advice falls back to a deterministic template.
- **Degraded mode always announces itself.** Replies in backup mode include "Running in backup mode" so people know the AI is offline.
- **Never gives medical advice.** The system only says "go here" or "call 911" — never dosing, diagnoses, or treatment instructions.

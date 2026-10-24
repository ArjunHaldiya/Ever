# CLAUDE.md — EVER

> EVER: "to be there always, enduring." Code, package names, and AWS resources use neutral names (`gateway`, `worker`, `dashboard`); the product name appears only in user-facing copy and docs.

## What we're building

EVER is an AI help line that keeps working during power outages. People text (or call) one number, an AI triages what they need, and they get routed to the nearest **open, powered** resource: pharmacy, cooling center, food site, or charging station. Before a planned shutoff, it warns opted-in residents with power-dependent needs and tracks whether they **read** the warning. If the AI fails, it keeps answering in degraded mode and loses no request.

**Pitch line:** "When the power goes out, the map still says the pharmacy is open. It isn't."

**Context:** SpartHill Hacks 2026 (SJSU × Foothill), Track 05: AI-Driven Automation & Critical Service Continuity (AWS). Build window ends Sat Oct 24, 10 AM; pitches 1–3 PM. Judging themes: sustainability, trust, privacy, measurable impact. AWS judges are the majority, so AWS must do the important work.

### It is
1. A text/call help line that turns a plain-language request into a routed answer with a one-line reason.
2. A shutoff-warning system with delivered/read tracking.
3. A responder dashboard (live map of needs, resource capacity, warning status, queue backlog).
4. Resilient by design: queue-first, with a degraded mode that needs no AI.

### It is not
- A medical advisor. It only says "go here," "bring this," or "call 911."
- A 911 replacement. Emergencies get told to call 911 immediately.
- An app people download, or a general-purpose chatbot.

## The demo (protect this above everything)

Three moments. Every task should serve one of them; nothing may break them.

1. **Judge gets help on their own phone.** Scan QR, enter number, we message first, they describe a need, they get routed in seconds.
2. **Warning lands, and we prove it.** Trigger a shutoff for a demo ZIP; a phone buzzes; dashboard flips that resident `sent → delivered → read` live.
3. **We break it on purpose.** Chaos toggle cuts the AI path; replies continue in degraded mode and say so; on restore, the queued backlog drains on screen.

## Architecture

```
Resident phone ──iMessage──► Photon Spectrum ──► gateway (always-on Node, App Runner/EC2)
                                                   │  verify, dedupe, enqueue
                                                   ▼
                                                 SQS (+ DLQ)
                                                   │
                                                   ▼
                                       worker (Lambda, SQS trigger)
                                 ┌─────────────────┴──────────────────┐
                    ai_mode=primary                         ai_mode=degraded / Bedrock fails / >4s
                 Bedrock extractor (tool use)               rules extractor (keywords + regex)
                                 └─────────────────┬──────────────────┘
                                                   ▼
                                  deterministic matcher (same code both paths)
                                                   ▼
                              reply (Bedrock-written or template) → Photon send
                                                   ▼
                                     DynamoDB ◄──── dashboard API ◄── dashboard (React + MapLibre)
```

### Key design rule: AI extracts, code decides
- The LLM only **extracts** a structured need (tier, need type, location text, emergency flag, language) and optionally **phrases** the reply.
- **Matching is deterministic code**: filter resources by `hasPower`, open now, capacity > 0, supports need type; sort by distance (haversine). Same matcher in both modes.
- Degraded mode swaps only the extractor (rules) and the reply writer (templates). This is why failover is cheap and reliable.

### Gotcha: why the gateway is not a Lambda
Photon's webhook handler runs **after** the HTTP response is sent (fire-and-forget). A Lambda can freeze once it returns, so that work may never run. The gateway is an always-on Node process consuming Photon's message stream (`app.messages`) that does three fast things: verify, dedupe, push to SQS. All real work happens in the SQS-triggered worker.

## Stack

| Layer | Choice |
|---|---|
| Language | TypeScript (strict) everywhere, Node 20+ |
| Monorepo | pnpm workspaces |
| Messaging | Photon `spectrum-ts` (iMessage). Use the `terminal` provider for local dev without Photon |
| Gateway | Node service on App Runner (or t3.small EC2) |
| Queue | SQS standard queue + DLQ (maxReceiveCount 3) |
| Worker | Lambda, SQS event source, batch size 1 |
| AI | Bedrock Converse API with tool use; model from `BEDROCK_MODEL_ID` (fast tier, e.g. a Haiku-class or Nova model) |
| Geocoding | Amazon Location Service; fallback to seeded ZIP-centroid table |
| PII | Amazon Comprehend `DetectPiiEntities` before storing message text |
| Data | DynamoDB (on-demand) |
| Chaos flag | SSM Parameter Store `/app/ai_mode` = `primary` \| `degraded` |
| Infra | AWS CDK (TypeScript) |
| Dashboard | React + Vite + MapLibre GL; polls dashboard API every 2s (no WebSockets) |
| Validation | zod for every external payload and every LLM output |

## Repo layout

```
/
├── CLAUDE.md
├── package.json / pnpm-workspace.yaml
├── packages/
│   ├── core/          # shared: types, zod schemas, matcher, rules extractor, templates, emergency check
│   ├── gateway/       # Photon listener → dedupe → SQS; also sends outbound messages
│   ├── worker/        # Lambda handler: extract → match → reply → persist
│   ├── api/           # Lambda + API Gateway: dashboard reads, chaos toggle, trigger shutoff
│   └── dashboard/     # React app
├── infra/             # CDK app
├── seed/              # resources.json, zip_centroids.json, demo_residents.json, seed script
└── scripts/           # demo helpers: reset-demo, trigger-shutoff, toggle-chaos
```

Put all business logic in `packages/core` as pure functions so it is testable without AWS.

## Functional requirements

### P0 — must work for the demo
| ID | Requirement |
|---|---|
| FR-1 | Acknowledge an inbound text within 3s ("Got it, finding help near you…") |
| FR-2 | **Emergency check runs first, before any AI.** Phrases like "can't breathe", "chest pain", "unconscious", "not breathing", "overdose" → immediate reply to call 911; then continue the normal flow |
| FR-3 | Extract a need: tier (`medical_critical` \| `food` \| `shelter_cooling` \| `info`), needType (`refrigeration`, `device_power`, `pharmacy`, `food`, `cooling`, `charging`, `info`), location text, language |
| FR-4 | Resolve location from the message; if missing, ask once ("What's your ZIP or nearest cross streets?") and hold state |
| FR-5 | Reply with nearest open, powered resource that fits: name, address, distance, hours, what to bring |
| FR-6 | One-line reason with every answer ("Chosen: has a generator and fridge space") |
| FR-7 | Redact PII before storing; store location rounded to ~3 decimal places |
| FR-8 | Dashboard map of live needs colored by tier, plus resources with remaining capacity |
| FR-9 | Degraded mode when chaos flag is on, Bedrock errors, or Bedrock takes >4s; replies say "Running in backup mode" |
| FR-10 | Every request goes through SQS; dashboard shows queue depth and backlog draining on recovery |
| FR-11 | Dashboard form: ZIP + shutoff time → message every opted-in resident in that ZIP |
| FR-12 | Track warning status per resident `sent → delivered → read` via Photon read receipts; live on dashboard |
| FR-13 | Idempotency: record Photon `message.id` (24h TTL) and skip duplicates |

### P1 — if time allows
- FR-14 Opt-in by text: `JOIN <zip> <need>`; `STOP` to leave
- FR-15 Decrement capacity on routing; update the iMessage resource card in place
- FR-16 Shortfall alert when demand in a ZIP exceeds open capacity
- FR-17 Time-to-resource metric on dashboard

### P2 — stretch
- FR-18 Voice: Photon SIP → AI voice platform calling our triage API as a tool
- FR-19 SMS fallback for non-iPhone recipients (Twilio or AWS End User Messaging)
- FR-20 Spanish and Vietnamese replies

**Do not start P1 until every P0 item works end to end. Do not start P2 until the demo script runs clean twice.**

## Non-functional targets
- Reply latency: <10s AI path, <3s degraded path.
- Zero message loss: 3 failures → DLQ → visible on dashboard.
- Safety: never give medical advice, dosing, or diagnoses. Never tell someone *not* to call 911.
- Privacy: no accounts; phone numbers stored hashed (SHA-256 + salt) except where needed to send warnings (opted-in residents only).
- Trust: every routed answer includes its reason; degraded mode is always announced.

## Data model (DynamoDB)

| Table | PK / SK | Fields |
|---|---|---|
| `Resources` | `id` | name, type, lat, lng, address, hasPower, capacity, capacityUnit, hours, supports[] |
| `Needs` | `id` | tier, needType, latRounded, lngRounded, zip, status (`new`/`routed`/`awaiting_location`/`failed`), resourceId, mode (`ai`/`degraded`), redactedText, createdAt, routedAt |
| `Residents` | `phoneHash` | zip, needType, optedIn, phone (opted-in only) |
| `Alerts` | `alertId` / `phoneHash` | zip, shutoffAt, sentAt, deliveredAt, readAt |
| `Conversations` | `phoneHash` | pending question, last needId, ttl |
| `Processed` | `messageId` | ttl (24h) |

## Contracts

### Extractor output (both AI and rules extractors return this; validate with zod)
```ts
type ExtractedNeed = {
  emergency: boolean;
  tier: "medical_critical" | "food" | "shelter_cooling" | "info";
  needType: "refrigeration" | "device_power" | "pharmacy" | "food" | "cooling" | "charging" | "info";
  locationText: string | null;
  language: "en" | "es" | "vi";
  confidence: number; // 0..1; below 0.5 → ask a clarifying question
};
```

### Bedrock usage
- One tool, `record_need`, whose input schema is `ExtractedNeed`. Force tool use; parse the tool input with zod; on parse failure fall back to the rules extractor.
- Timeout 4s via AbortController. Any error or timeout → rules extractor, mode = `degraded`.
- The system prompt must forbid medical advice and must not invent resources. The model never sees the resource list for selection; the matcher picks.

## Environment variables
```
AWS_REGION=us-west-2
BEDROCK_MODEL_ID=
QUEUE_URL=
DLQ_URL=
TABLE_PREFIX=app-
AI_MODE_PARAM=/app/ai_mode
PHONE_HASH_SALT=
SPECTRUM_PROJECT_ID=
SPECTRUM_PROJECT_SECRET=
SPECTRUM_WEBHOOK_SECRET=
LOCATION_PLACE_INDEX=
DEMO_MODE=true      # enables seeded data + cached replies
```
Keep secrets in `.env.local` (gitignored) and SSM/Secrets Manager in AWS. **Never commit secrets or print them in logs.**

## Seed data (`seed/`)
- `resources.json`: ~30 San Jose resources (pharmacies, cooling centers, food sites, charging stations), each with `hasPower`, `capacity`, `hours`, `supports`. Mark clearly as **demo data**, not real availability.
- `zip_centroids.json`: San Jose ZIPs → lat/lng (fallback geocoder).
- `demo_residents.json`: opted-in team phones for the warning demo.
- `pnpm seed` loads all of it; `pnpm demo:reset` restores capacities, clears needs/alerts.

## Commands (target)
```
pnpm install
pnpm dev:gateway        # local, terminal provider, no Photon needed
pnpm dev:dashboard
pnpm test               # vitest, packages/core
pnpm seed
pnpm demo:reset
pnpm demo:shutoff 95112
pnpm demo:chaos on|off
pnpm cdk deploy
```

## Build order
1. `core`: types, zod schemas, emergency check, rules extractor, matcher, templates + tests.
2. Local loop: terminal provider → core → reply in terminal (no AWS yet).
3. AWS: CDK for SQS/DLQ, DynamoDB, worker Lambda, SSM flag; seed data.
4. Gateway with Photon: real iMessage in → SQS → worker → reply. **Test an Android number in this step** and record the result here.
5. Bedrock extractor with 4s timeout + fallback.
6. Dashboard API + dashboard (map, needs, capacity, queue depth, chaos toggle).
7. Shutoff warnings + read receipts.
8. Freeze at 8 AM Sat: stability, cached demo responses, backup video.

## Conventions
- Small, pure functions in `core`; side effects only in handlers.
- Every external input (Photon payloads, SQS bodies, LLM output, HTTP bodies) parsed with zod.
- Structured JSON logs with `needId` / `messageId`; redact phone numbers and message text.
- Handlers are idempotent; assume at-least-once delivery everywhere.
- Prefer boring and reliable over clever. No new dependencies without a clear reason.
- Write tests for the matcher, emergency check, and rules extractor before wiring AWS.

## Rules for Claude working in this repo
- Keep the demo path working after every change; if a change risks it, say so first.
- Don't build P1/P2 features until P0 is done unless asked.
- Ask before running `cdk deploy`, deleting AWS resources, or sending real messages to numbers not in `demo_residents.json`.
- Never hardcode secrets, phone numbers, or real personal data.
- Don't invent statistics or claim real-world resource availability; seed data is labeled demo.
- When something is blocked on an external service (Photon plan limits, Bedrock access, phone registration), stop and report it with a fallback rather than working around it silently.

## Open questions
- [x] Final product name: EVER.
- [ ] Do Photon messages reach Android numbers on our plan? (decides FR-19 priority and pitch wording)
- [ ] Does inbound-first work on the shared-pool line, or must we always message first?
- [ ] Bedrock model access approved in our region?
- [ ] Anchor statistic for the pitch (cited).

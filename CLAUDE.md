# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## How to Work

**Use the fork model.** Break all coding tasks into subtasks and delegate to subagents. Don't do everything in a single thread — fork early and often.

**Be concise.** Fix it, build it, move on. Don't explain what's obvious from the diff. Save words for things that matter.

**Explain reasoning before non-trivial changes.** If you're introducing a new pattern, changing architecture, restructuring data flow, or making a decision that affects more than the immediate task — explain *why* before writing code.

**Ask on ambiguity.** Don't silently decide on error handling strategy, new patterns, schema changes, or anything where multiple reasonable approaches exist. Surface the tradeoff and ask.

**Don't parrot code back.** Never repeat large blocks of existing code in explanations. Reference by function name, file, or line number instead.

**Replicate reference files exactly.** When given a file as a gold standard or example to follow, match its patterns, structure, and style closely. Don't freelance.

## What is ATTAIRE?

ATTAIRE is a fashion identification app — users photograph an outfit, AI identifies each garment (brand, material, price range), and the app finds where to buy those items or similar alternatives. The name hides "AI" in plain sight with a French fashion-house feel.

## Repository Structure

Monorepo with three independent packages (each has its own `node_modules` and `package.json`):

- **`attair-app/`** — React 19 SPA (Vite 8). The entire frontend lives in a single 11K-line `App.jsx` — all views, routing logic, and state are in this one file. Uses `VITE_API_BASE` env var to point at the backend.
- **`attair-backend/`** — Express 4 API server. Handles outfit identification (via Anthropic Claude API), product search (SerpAPI), auth (Supabase), payments (Stripe), push notifications (web-push), and various AI-powered features. Deployed on Railway.
- **`agents/`** — Discord bot (`discord-bot.js`) that serves as the sole development interface. Uses Claude CLI (`claude -p`) for AI interactions and runs build/judge/fix loops. Also deployed on Railway via Docker.
- **`supabase/`** — Empty; migrations live in `attair-backend/sql/` and are run via `npm run db:setup` from the backend.

## Common Commands

### Frontend (`attair-app/`)
```bash
npm run dev      # Vite dev server
npm run build    # Production build
npm run lint     # ESLint
```

### Backend (`attair-backend/`)
```bash
npm run dev       # Node --watch (auto-restart on changes)
npm start         # Production start
npm test          # vitest run (all tests)
npm run test:watch # vitest in watch mode
npm run db:setup  # Run SQL migrations against Supabase
```

### Discord Bot (`agents/`)
```bash
npm start         # Launch bot
npm test          # vitest run
```

## Architecture Details

### Backend API Pattern
All routes are under `/api/` prefix. Route files in `src/routes/` export Express routers. Key services:
- `src/services/claude.js` — Anthropic API calls for outfit identification (uses raw HTTP to `api.anthropic.com`, **not** the SDK — keep it that way)
- `src/services/products.js` — Product search and scoring
- `src/services/notifications.js` — Push notification delivery + nudge processor
- `src/lib/supabase.js` — Shared Supabase client (service role)
- `src/middleware/auth.js` — `requireAuth` verifies Supabase JWT from `Authorization: Bearer` header, attaches `req.user` and `req.userId`

### Auth Flow
Supabase handles OAuth (Google). The frontend stores access/refresh tokens in localStorage and uses a `authFetch()` wrapper that auto-retries on 401 by refreshing the token. Guest mode uses a device fingerprint stored in `attair_guest_id`.

### Cron Jobs (in-process)
Three scheduled tasks run inside the Express server process via `setTimeout`/`setInterval`:
- Style Twins weekly notify (every 7 days)
- Outfit of the Week generate (Mondays)
- Weekly Style Reports (Sundays)

All use `x-cron-key` header for auth, matching `CRON_SECRET` env var.

### Database
PostgreSQL via Supabase. Migrations are numbered SQL files in `attair-backend/sql/` (001 through 016).

**Running migrations via Supabase CLI** (preferred):
```bash
cd attair-backend
npx supabase link --project-ref cmlgqztjkrfipzknwnfm  # one-time setup
npx supabase db query --linked -f sql/016-hanger-test-v2.sql  # run specific migration
```

### CLI Tools Available
- **Supabase CLI**: `npx supabase` — run migrations, query DB, manage project. Project is linked to ref `cmlgqztjkrfipzknwnfm`.
- **Railway CLI**: `npx railway` — manage services, view logs, check env vars, redeploy. Backend service is "ATTAIR" (ID `439990b3-e4b3-4b1f-bdbb-ec94885bf784`).

### Required Environment Variables (backend)
`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`, `ANTHROPIC_API_KEY`, `SERPAPI_KEY`, `CRON_SECRET_KEY`. Stripe keys are optional.

## Working in App.jsx

The frontend is a single 11K-line file with no formal section conventions. When working in it:
- **Search before editing.** The file is large — always search for the component/function/state you need rather than scrolling. Multiple features may reference the same state.
- **Match surrounding patterns.** There's no enforced architecture; follow the style of the code immediately around your changes.
- **Test your changes visually.** Run `npm run dev` from `attair-app/` and verify in the browser. There's no component isolation (no Storybook), so the running app is the test.
- **Be cautious with shared state.** Since everything is in one file, a state variable you think is local may be used by multiple views. Grep before renaming or removing.

## Code Style

No enforced style guide beyond ESLint. Match the conventions of the surrounding code. General patterns observed in the codebase:
- Functional components with hooks (React 19)
- `async/await` over raw promises in the backend
- Express route handlers follow `(req, res) => {}` with try/catch
- Environment variables accessed directly via `process.env` (backend) and `import.meta.env` (frontend)

## Testing

### Backend (`attair-backend/`)
- **Framework:** Vitest + Supertest for API route/integration tests.
- **Mocking:** External services (Supabase, Anthropic, SerpAPI) are mocked. When adding tests for a new route, follow the mocking patterns in existing test files — don't call real external APIs in tests.
- **Running:** `npm test` runs all tests. `npm run test:watch` for development.
- **What to test:** All new API routes should have tests covering the happy path and at least one error case (auth failure, missing params, upstream service error).

### Frontend (`attair-app/`)
- Snapshot/integration tests exist. When modifying UI behavior, check whether existing snapshots need updating.
- Run `npm run build` as a smoke test — Vite's build will catch import errors and type issues that the dev server might not.

### General Testing Rules
- Never commit code that breaks existing tests. Run `npm test` from the relevant package before considering work done.
- If a change is hard to test automatically, note it explicitly in your commit/PR message.

## Deployment

**Merging to `main` auto-deploys everything:**
- Backend → Railway (nixpacks)
- Discord bot → Railway (Docker, `agents/Dockerfile`)
- Frontend → Vercel

This means every merge to `main` is a production deploy. Be certain tests pass and the build succeeds before merging. There is no staging environment.

## Known Tech Debt & Gotchas

<!-- Add items here as they come up. Format: short description + what to do about it. -->
- **App.jsx is 11K lines.** The entire frontend is one file. This is known; don't attempt to refactor it into components unless explicitly asked. Work within the current structure.
- **Anthropic calls use raw HTTP, not the SDK.** `src/services/claude.js` makes direct `fetch` calls to `api.anthropic.com`. Don't migrate to the `@anthropic-ai/sdk` package — the raw approach is intentional.
- **No staging environment.** Main = production. Test locally before merging.
- **In-process cron jobs.** The scheduled tasks (Style Twins, Outfit of the Week, Weekly Reports) run inside the Express process, not as separate workers. A server restart resets their timers. Be aware of this when modifying server startup.
- **SQL migrations are manual.** Numbered files in `attair-backend/sql/`. If you add a migration, use the next sequential number (e.g., `016-your-migration.sql`) and update `db:setup` if needed.

<!-- TEMPLATE for adding new items:
- **Short name.** Description of the issue and what to do (or not do) about it.
-->

## API Contract: Frontend ↔ Backend

There is no formal schema or type contract between frontend and backend. When changing a backend response shape:
1. Search `App.jsx` for all references to the affected endpoint URL.
2. Trace how the response data is destructured and used.
3. Update both sides in the same commit/PR to avoid breaking production (remember: auto-deploy).

## Brand Reference
See `brand-dna.md` for colors (`#C9A96E` gold primary, `#0C0C0E` dark bg), typography (Outfit + Instrument Serif), voice guidelines, and design principles.

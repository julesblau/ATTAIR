# ATTAIR — Outstanding Items

## Verify (deployed, need hard-refresh + manual test)
- [ ] Scan counter shows correct count (not 0/12)
  - Root cause was RPC type mismatch (DATE vs TEXT) + global rate limit too low (100→300 req/min)
  - Fixed via sql/019 migration + index.js rate limit bump
- [ ] Refine search returns meaningfully different results (e.g. "find in red")
  - Was only changing `item.name`, not `item.search_query` — now sets both + clears alt_search
  - Also strips markdown fences from Haiku response (was causing 422)
- [ ] Save Look button opens wishlist picker (no spam-saving)
  - Rewritten to open picker immediately, no backend calls until user picks a collection
- [ ] Infinite loop scroll on product card carousels
  - Tripled product array + scroll jump at boundaries for seamless endless swiping
- [ ] Share links work end-to-end (text a friend, they see the outfit)
  - Backend /share/:id was working (OG tags, redirect) but Vercel returned 404 on /scan/:id
  - Fixed by adding attair-app/vercel.json with SPA rewrites
- [ ] Product card first-card cutoff is gone
  - Replaced paddingLeft with spacer divs (scroll-snap + padding don't play well together)

## Not Done
- [ ] Stripe end-to-end checkout test
  - Code is fixed (webhook handler for customer.subscription.updated, FRONTEND_URL fallback, polling loop)
  - Never tested a real checkout flow — need to run through test mode
- [ ] Reconnect Vercel GitHub auto-deploy
  - GitHub integration is disconnected — pushes to main don't auto-deploy frontend
  - Fix: Vercel dashboard → Settings → Git → reconnect repo
  - Currently deploying manually via `npx vercel deploy --prod` from repo root
- [ ] Hanger Test v2 — Tinder-style 5-outfit daily cadence
  - Full plan in .claude/plans/majestic-yawning-milner.md
  - DB migration, backend routes, frontend card stack UX, taste profiles, streak rewards
- [ ] Capacitor iOS wrap
  - Also in the same plan file
  - Everything except Xcode can be done on Windows (packages, config, code changes)
  - macOS needed for: Xcode signing, build, simulator, App Store submission
  - Apple Dev Account ($99/yr) needed first

## Cleanup
- [ ] Delete stale `attair-app` Vercel project (keep `attair` — that's production at attair.vercel.app)
- [ ] Delete `auto-fixes` git branch (changes already on main)

## Recent Fixes (already deployed, for reference)
- Premium tier pricing: items cheaper than Match tier were appearing in Premium — added post-tier price sanity check with median comparison + demotion logic
- extractPrice TDZ crash: `const extractPrice` shadowed module-level function, renamed to `tierPrice`
- Wardrobe → My Wardrobe rename
- Stripe webhook: added customer.subscription.updated handler
- Rate limit: bumped global from 100 to 300 req/min (app fires 15+ API calls per navigation)
- Backend env: code uses CRON_SECRET (not CRON_SECRET_KEY) — local .env updated

## Environment Notes
- Main branch = production (auto-deploys backend to Railway, frontend needs manual Vercel deploy until GitHub integration is reconnected)
- Backend: Railway (attair-production.up.railway.app)
- Frontend: Vercel (attair.vercel.app)
- DB: Supabase (migrations in attair-backend/sql/, run via npm run db:setup)

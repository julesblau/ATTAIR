# ATTAIR Backend — API Server

Node.js/Express backend for the ATTAIR outfit identification app. Handles AI clothing identification (Claude API), three-tier product search (SerpAPI), user management (Supabase Auth), affiliate tracking, and ad event logging.

---

## Architecture

```
Client (fashion-finder.jsx)
  │
  ├─ POST /api/auth/signup|login     → Supabase Auth → JWT
  ├─ POST /api/identify              → Claude Vision API → identified items
  ├─ POST /api/find-products         → SerpAPI Google Shopping → 3-tier results
  ├─ GET  /api/user/status           → tier, scans remaining, show_ads
  ├─ POST /api/go/:click_id          → log click → 302 redirect (affiliate URL)
  └─ POST /api/ad-events             → log impression/click/upgrade
```

---

## Prerequisites — Accounts You Need

Create these **before** you can run the server:

| # | Service | Cost | URL | What You Need |
|---|---------|------|-----|---------------|
| 1 | **Supabase** | Free tier | https://supabase.com | Project URL + service role key + anon key |
| 2 | **Anthropic** | Pay-per-use (~$0.01/scan) | https://console.anthropic.com | API key (sk-ant-...) |
| 3 | **SerpAPI** | $50/mo (100 searches/mo free) | https://serpapi.com | API key |
| 4 | **Amazon Associates** | Free (1-3 day approval) | https://affiliate-program.amazon.com | Affiliate tag (e.g. attair-20) |

That's it for Phase 1a. The other services (AdMob, RevenueCat, Stripe, Firebase) come in later phases.

---

## Setup — Local Development

### 1. Clone and install

```bash
git clone <your-repo>
cd attair-backend
npm install
```

### 2. Create your `.env` file

```bash
cp .env.example .env
```

Fill in every value. Here's where to find each key:

- **SUPABASE_URL**: Supabase Dashboard → Project Settings → API → Project URL
- **SUPABASE_SERVICE_ROLE_KEY**: Same page → `service_role` key (secret — never expose to client)
- **SUPABASE_ANON_KEY**: Same page → `anon` / `public` key
- **ANTHROPIC_API_KEY**: https://console.anthropic.com → API Keys → Create Key
- **SERPAPI_KEY**: https://serpapi.com → Dashboard → Your API Key
- **AMAZON_AFFILIATE_TAG**: Amazon Associates dashboard → your tracking ID

### 3. Set up the database

Open your Supabase project's **SQL Editor** (Dashboard → SQL Editor → New Query).

Copy and paste the entire contents of `sql/001-schema.sql` and click **Run**.

This creates all 6 tables, indexes, RLS policies, and the auto-create-profile trigger.

### 4. Start the server

```bash
npm run dev
```

The server starts on `http://localhost:3000`. Test it:

```bash
curl http://localhost:3000/
# → { "service": "ATTAIR API", "version": "1.0.0", "status": "ok", ... }
```

---

## Deploy to Railway

### 1. Push to GitHub

```bash
git init
git add .
git commit -m "ATTAIR backend Phase 1a"
git remote add origin https://github.com/YOUR_USER/attair-backend.git
git push -u origin main
```

### 2. Create Railway project

1. Go to https://railway.app and sign in with GitHub
2. Click **New Project** → **Deploy from GitHub repo**
3. Select your `attair-backend` repo
4. Railway auto-detects Node.js and starts building

### 3. Set environment variables

In Railway's dashboard for your service:
1. Click **Variables** tab
2. Click **Raw Editor** and paste:

```
PORT=3000
NODE_ENV=production
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJhbG...
SUPABASE_ANON_KEY=eyJhbG...
ANTHROPIC_API_KEY=sk-ant-api03-...
SERPAPI_KEY=your-key
AMAZON_AFFILIATE_TAG=attair-20
CORS_ORIGINS=https://attair.app,https://your-frontend.vercel.app
```

3. Click **Update variables** — Railway auto-redeploys

### 4. Get your public URL

Railway assigns a URL like `attair-backend-production.up.railway.app`.

You can also add a custom domain under **Settings → Networking → Custom Domain**.

### 5. Point your frontend at it

In your frontend, update the API base URL:

```js
const API_BASE = "https://attair-backend-production.up.railway.app";
```

---

## API Reference

### Authentication

All protected endpoints require:
```
Authorization: Bearer <supabase_access_token>
```

Get a token via `POST /api/auth/login` or `POST /api/auth/signup`.

---

### POST /api/auth/signup

Create account + get token.

```json
// Request
{ "email": "user@example.com", "password": "securepass", "gender_pref": "men", "budget_pref": "mid" }

// Response 200
{ "user": { "id": "uuid", "email": "..." }, "access_token": "eyJ...", "refresh_token": "..." }
```

### POST /api/auth/login

```json
// Request
{ "email": "user@example.com", "password": "securepass" }

// Response 200
{ "user": { "id": "uuid", "email": "..." }, "access_token": "eyJ...", "refresh_token": "..." }
```

### POST /api/auth/refresh

```json
// Request
{ "refresh_token": "..." }

// Response 200
{ "access_token": "eyJ...", "refresh_token": "..." }
```

---

### POST /api/identify 🔒

Upload a photo, get identified clothing items.

**Rate limited**: Free users = 3/day. Pro = unlimited.

```json
// Request
{
  "image": "base64-encoded-jpeg-string",
  "mime_type": "image/jpeg",
  "user_prefs": { "gender": "men", "budget": "mid" }
}

// Response 200
{
  "scan_id": "uuid",
  "gender": "male",
  "summary": "Casual streetwear outfit...",
  "items": [
    {
      "name": "Oversized Half-Zip Fleece Hoodie",
      "brand": "Lululemon",
      "brand_confidence": "confirmed",
      "category": "top",
      "subcategory": "hoodie",
      "color": "heather grey",
      "search_query": "oversized half-zip fleece hoodie heather grey mens",
      "price_range": "$108 - $128",
      "identification_confidence": 87
    }
  ],
  "user_scans_remaining": 2,
  "user_tier": "free"
}

// Response 429 (limit hit)
{ "error": "Daily scan limit reached", "scans_remaining": 0, "upgrade_url": "/subscribe" }
```

---

### POST /api/find-products 🔒

Get three-tier shopping results for identified items.

```json
// Request
{
  "items": [ ...items from /api/identify... ],
  "gender": "male",
  "scan_id": "uuid-from-identify"
}

// Response 200
[
  {
    "item_index": 0,
    "brand_verified": true,
    "tiers": {
      "budget":  { "product_name": "...", "brand": "H&M",       "price": "$34.99",  "url": "...", "why": "..." },
      "mid":     { "product_name": "...", "brand": "COS",       "price": "$89.00",  "url": "...", "why": "..." },
      "premium": { "product_name": "...", "brand": "Lululemon", "price": "$118.00", "url": "...", "why": "...", "is_identified_brand": true }
    }
  }
]
```

---

### GET /api/user/status 🔒

```json
// Response 200
{
  "tier": "free",
  "scans_remaining_today": 2,
  "scans_limit": 3,
  "saved_count": 5,
  "saved_limit": 20,
  "history_days": 7,
  "trial_ends_at": null,
  "show_ads": true
}
```

---

### POST /api/go/:click_id

Affiliate redirect. Logs the click, then 302s to the affiliate-tagged product URL.

```json
// Request
{
  "scan_id": "uuid",
  "item_index": 0,
  "tier": "budget",
  "retailer": "Amazon",
  "product_url": "https://www.amazon.com/dp/B09XYZ..."
}

// Response: 302 redirect to https://www.amazon.com/dp/B09XYZ...?tag=attair-20
```

Also supports GET with query params for simple links:
```
GET /api/go/abc123?url=https://amazon.com/...&tier=budget&retailer=Amazon
```

---

### POST /api/ad-events 🔒

Log ad impressions, clicks, and upgrade actions.

```json
// Request
{ "ad_type": "interstitial", "ad_placement": "post_scan", "action": "impression" }

// Response 200
{ "ok": true }
```

---

## Project Structure

```
attair-backend/
├── src/
│   ├── index.js              ← Express app entry point
│   ├── lib/
│   │   └── supabase.js       ← Supabase service-role client
│   ├── middleware/
│   │   ├── auth.js            ← JWT verification (requireAuth / optionalAuth)
│   │   └── rateLimit.js       ← Daily scan counter (free=3, pro=unlimited)
│   ├── routes/
│   │   ├── auth.js            ← signup / login / refresh
│   │   ├── identify.js        ← POST /api/identify (Claude API)
│   │   ├── findProducts.js    ← POST /api/find-products (SerpAPI)
│   │   ├── user.js            ← status / history / saved
│   │   ├── affiliate.js       ← POST|GET /api/go/:click_id
│   │   └── adEvents.js        ← POST /api/ad-events
│   └── services/
│       ├── claude.js          ← Anthropic API integration
│       └── products.js        ← SerpAPI search + scoring + caching
├── sql/
│   └── 001-schema.sql         ← Full database schema (run in Supabase SQL Editor)
├── .env.example
├── .gitignore
├── package.json
├── railway.toml
└── README.md
```

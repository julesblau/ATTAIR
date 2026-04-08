# Unresolved Issues — E2E Test Run 2026-04-08

These issues were found during the comprehensive E2E crawl but cannot be fixed without
external credentials or manual intervention.

## 1. Anthropic API Key Invalid
- **Endpoint**: `POST /api/identify`
- **Error**: `Anthropic API 401: invalid x-api-key`
- **Impact**: All outfit scans fail with 500 error
- **Fix**: Replace `ANTHROPIC_API_KEY` in `attair-backend/.env` with a valid key from https://console.anthropic.com

## 2. Stripe Keys Not Configured
- **Endpoint**: `POST /api/payments/create-checkout-session`
- **Error**: `STRIPE_SECRET_KEY not set`
- **Impact**: "Go Pro" checkout fails (now shows toast instead of raw alert)
- **Fix**: Set `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` in `attair-backend/.env`

## 3. Style Twins Missing DB Column
- **Endpoint**: `GET /api/style-twins`
- **Error**: `column profiles.style_dna_cache does not exist`
- **Impact**: Style Twins tab returns 500
- **Fix**: Run migration `sql/020-style-dna-cache.sql` against Supabase:
  ```bash
  cd attair-backend
  npx supabase db query --linked -f sql/020-style-dna-cache.sql
  ```

## 4. Social Media Links Dead
- Instagram: https://instagram.com/attaire.app → "Profile isn't available"
- TikTok: https://tiktok.com/@attaire.app → "Couldn't find this account"
- X/Twitter: https://x.com/attaireapp → Empty profile
- **Fix**: Create the social media accounts or update links to valid profiles

## 5. Pre-existing Lint Errors (22 warnings)
- All in `App.jsx` — unused variables from the 11K-line monolith
- None introduced by this fix session
- Not addressed per instructions (don't modify code beyond what was asked)

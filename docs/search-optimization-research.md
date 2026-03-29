# ATTAIR Search Optimization Research

**Date**: 2026-03-28
**File**: `attair-backend/src/services/products.js` (2079 lines)

## Current Pipeline Summary

```
Scan Image
  |
  v
[Google Lens] ──parallel──> [Text Search (SerpAPI Shopping)]
  |                              |
  v                              v
matchLensResultToItem()     scoreProduct() for each result
  |                              |
  v                              v
  Merge + URL dedup + market filter
  |
  v
  productFingerprint() dedup
  |
  v
  Find original (brand-matched Lens result)
  |
  v
  Tier partition: budget / mid / premium / resale
  |
  v
  Return up to 6 per tier
```

**Timing**: Fast mode ~5s, Extended mode ~15-25s.

---

## Scoring Weights (Current)

| Signal | Points | Notes |
|--------|--------|-------|
| Brand exact match | +30 | Strongest semantic signal |
| Subcategory exact match | +25 | Core product type |
| Lens visual match | +25 | High confidence signal |
| Trusted retailer | +20 | Quality data source |
| Product line match | +20 | Specific model identification |
| Synonym match | +20 | Handles language variation |
| Liked brand (pref) | +15 | User preference boost |
| Body type match | +15 | Personalization |
| Price in-budget (custom) | +45 | Primary purchase driver |
| Price in-budget (default) | +30 | Moderate when unset |
| Knockoff penalty | -50 | Safety guard |
| Gender mismatch | -40 | Correctness filter |
| Way too cheap (< 10% min) | -60 | Likely wrong product |
| Avoided brand (pref) | -20 | User preference penalty |

---

## Top 10 Optimization Opportunities

### 1. Retailer Diversity in Tiers (HIGH IMPACT)

**Problem**: Same retailer can dominate all slots in a tier (e.g., ASOS fills all 6 budget slots).

**Solution**: After scoring, apply a diversity pass:
- First product from a retailer: full score
- Second product from same retailer: score * 0.8
- Third+: score * 0.6

This naturally diversifies without hard limits. Implementation: ~20 lines in the tier-filling loop.

**Expected impact**: Better price comparison for users, higher click-through variety.

### 2. Query Construction: Token Bucketing (MEDIUM IMPACT)

**Problem**: 80-character limit truncates useful signals. "petite women's navy cotton sweater crewneck" (49 chars) is more indexable than "beautiful premium quality lightweight comfortable navy sweater" (60 chars). The `stripShoppingNoise()` function helps but runs after truncation.

**Solution**:
1. Run `stripShoppingNoise()` BEFORE the 80-char limit (currently after)
2. Token-weight approach: assign Shopping-indexability scores to each word
   - High: brand, color, gender, subcategory, material
   - Medium: occasion, fit, size term
   - Low: adjectives, modifiers
3. Build query by filling highest-value tokens until 80 chars

**Expected impact**: Better relevance without additional API calls.

### 3. Lens Match Threshold Tightening (MEDIUM IMPACT)

**Problem**: Minimum score of 10 means a single category match can assign a Lens result to an item. "Shoes" category match (10 pts) could incorrectly assign a sandal result to a boot item.

**Solution**: Raise minimum from 10 to 18 (requires category + at least partial subcategory match). Or require minimum 2 distinct signal types.

**Expected impact**: Fewer false positive Lens assignments, cleaner mid-tier products.

### 4. Negative Feedback Loop (HIGH IMPACT, MEDIUM EFFORT)

**Problem**: When users see products they don't want (via "Not for me" verdict), this information is lost. The preference engine stores verdicts but doesn't feed them back into search scoring.

**Solution**:
1. On "Not for me" verdict, store the `productFingerprint()` in a user's "rejected" set
2. During scoring, check fingerprint against rejected set: -15 penalty
3. Also track rejected *brands per subcategory* (e.g., "I don't like Nike sneakers" shouldn't penalize Nike jackets)

**Expected impact**: Results improve with usage. Each scan gets more personalized.

### 5. Substring Synonym Matching Fix (LOW EFFORT, MEDIUM IMPACT)

**Problem**: Current synonym matching uses `includes()` which causes false positives. "blouse" would match in "blue suede shoes" because of substring overlap patterns.

**Solution**: Use word-boundary matching:
```javascript
// Current (buggy for short terms):
title.includes(term)

// Fixed:
new RegExp(`\\b${escapeRegex(term)}\\b`, 'i').test(title)
```

Or simpler: split title into words and check word-level inclusion.

**Expected impact**: Fewer false positive scores, especially for short garment terms.

### 6. Extended Mode: Retailer Diversity Check (LOW EFFORT)

**Problem**: Extended mode skips text search if 5+ priced Lens results found. But 5 results from the same 2 retailers isn't diverse enough.

**Solution**: Change threshold to require 5+ priced results from 3+ unique domains:
```javascript
const uniqueDomains = new Set(pricedLens.map(p => new URL(p.link).hostname));
if (pricedLens.length >= 5 && uniqueDomains.size >= 3) skipText = true;
```

**Expected impact**: Better coverage for items where Lens finds many results but from few retailers.

### 7. Smart Cache Invalidation (MEDIUM EFFORT)

**Problem**: 24h text cache means fast-fashion inventory (Zara, ASOS, H&M) may show unavailable items.

**Solution**: Tiered cache TTL based on retailer:
- Fast fashion (Zara, ASOS, H&M, Shein): 6 hours
- Standard retail (Nordstrom, Bloomingdale's): 24 hours
- Luxury (Net-a-Porter, Ssense): 48 hours

Implement by checking source domain when setting cache.

**Expected impact**: Fewer broken links, better price accuracy.

### 8. Price Range Asymmetric Expansion (LOW EFFORT)

**Problem**: Current expansion is symmetric (0.5x-1.5x around budget). But users want more options *above* budget (aspirational) than below (perceived as lower quality).

**Solution**: Asymmetric expansion:
```javascript
const floor = budgetMin * 0.6;  // 40% below
const ceil = budgetMax * 2.0;   // 100% above
```

This matches user psychology: willing to stretch budget upward, but not downward.

**Expected impact**: Better premium tier filling, more "aspirational" options.

### 9. Claude Re-ranking Prompt Optimization (MEDIUM EFFORT)

**Problem**: Extended mode sends top 15 products to Claude for re-ranking. The prompt quality determines output quality.

**Current prompt context**: Unknown (in `rerankCandidates()` function).

**Opportunity**: Include in the prompt:
- User's preference profile (liked brands, avoided brands, color prefs)
- The specific item being matched (brand + subcategory + color)
- Budget context ("user set a $200-500 budget")
- Occasion context

**Expected impact**: Better re-ranking in extended mode, more relevant product annotations.

### 10. Parallel SerpAPI Call Throttling (OPERATIONAL)

**Problem**: A scan with 8 items fires 16+ SerpAPI calls simultaneously (2 per item + Lens). This creates burst traffic that can hit rate limits.

**Solution**: Implement a semaphore pattern:
```javascript
const CONCURRENT_SERP_LIMIT = 6;
const semaphore = { active: 0, queue: [] };
```

Queue SerpAPI calls and release when previous ones complete. Prevents rate limiting while maintaining throughput.

**Expected impact**: Fewer API failures on multi-item scans, more predictable latency.

---

## Quick Wins (< 1 hour each)

1. **stripShoppingNoise before truncation** — move line 975 `cleanForSearch()` + `stripShoppingNoise()` calls to before the 80-char limit check
2. **Lens match threshold to 18** — change line 707 from `>= 10` to `>= 18`
3. **Word-boundary synonym matching** — update line 1125 to use regex `\b` instead of `includes()`
4. **Retailer diversity multiplier** — add 15-line decay function in tier-filling loop

## Medium Effort (1-4 hours)

5. **Negative feedback integration** — read user verdicts, apply fingerprint penalties
6. **Tiered cache TTL** — add retailer → TTL mapping in `setCache()`
7. **Asymmetric price expansion** — adjust floor/ceil ratios
8. **Token-weighted query builder** — replace truncation with priority token selection

## Larger Initiatives (1+ days)

9. **A/B testing framework** — compare scoring variants against user satisfaction
10. **Search telemetry dashboard** — track which signals most correlate with user engagement
11. **ML-based scoring** — train a model on verdict data to predict optimal weights

---

## Current SerpAPI Cost Model

| Operation | API Calls | Cost/scan (est.) |
|-----------|-----------|------------------|
| Google Lens | 1 per scan | $0.05 |
| Text search (fast) | 2 per item | $0.05 × items × 2 |
| Text search (extended) | 2-5 per item | $0.05 × items × 3-5 |
| **Typical 4-item fast scan** | 9 calls | ~$0.45 |
| **Typical 4-item extended** | 13-21 calls | ~$0.65-$1.05 |

**Optimization target**: Reduce redundant calls via better caching and early-exit logic. Current cache hit rate unknown — add instrumentation.

---

## Recommendation Priority

1. **Retailer diversity** — directly improves perceived result quality
2. **Negative feedback loop** — compounds value with usage
3. **Query construction fix** — free improvement (better queries = better results at same cost)
4. **Lens threshold** — reduces noise with zero additional cost
5. **Synonym fix** — correctness improvement, low risk

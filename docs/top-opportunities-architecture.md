# Top Opportunities — How it works, why it's hard

## The 30-second version

Algorand DeFi has **no single API** that lists "all pools sorted by APY." We have to stitch one together from three sources, each with its own gaps and quirks. That's why pools occasionally go missing or show stale numbers.

---

## The data pipeline

```
                     ┌──────────────────────────────────────┐
                     │         BROWSER (your visitor)       │
                     └──────────────────┬───────────────────┘
                                        │
                ┌───────────────────────┼───────────────────────┐
                │                       │                       │
                ▼                       ▼                       ▼
       ┌────────────────┐      ┌────────────────┐      ┌────────────────┐
       │ Tinyman V1     │      │ Vestige        │      │ Pact API       │
       │ analytics      │      │ assets+pools   │      │ /api/pools     │
       │ (1 listing)    │      │ (many calls)   │      │ (1 listing)    │
       └────────┬───────┘      └────────┬───────┘      └────────┬───────┘
                │                       │                       │
                │ V1 pools +            │ V2 pool               │ Pact pools
                │ v2_addresses          │ addresses             │ + APR
                │                       │                       │
                │                       ▼                       │
                │              ┌────────────────┐               │
                │              │ Tinyman V2     │               │
                │              │ analytics      │               │
                │              │ (1 per pool)   │               │
                │              └────────┬───────┘               │
                │                       │                       │
                │                       │ V2 pools + APY        │
                ▼                       ▼                       ▼
              ┌──────────────────────────────────────────────────┐
              │  Merge → sort by APY desc → top 15 → render     │
              │  Cache result in localStorage (30 min)          │
              └──────────────────────────────────────────────────┘
```

---

## What each source gives us

| Source | What it gives | What it doesn't |
|---|---|---|
| **Tinyman V1 analytics** `/pools/?limit=200` | All V1 pools with APY/TVL in one call. Also includes `v2_address` for the V2 counterpart pool. | **No V2 pools** in the listing. Only V1 data. |
| **Vestige `/assets/list`** | Top 100 tokens by TVL across all of Algorand | No APY data |
| **Vestige `/pools`** | Pool addresses for any (asset_1, asset_2) pair on Tinyman V2 | No APY, no TVL in USD. Ordered by *creation date*, not TVL. |
| **Tinyman V2 analytics** `/pools/{address}/` | APY + TVL for a specific V2 pool | **No listing endpoint** — you must already know the address |
| **Pact API** `/api/pools` | All Pact pools with APR + TVL | `ordering` param is silently ignored. Returns by TVL desc. `is_verified=true` filters out ~99% of community pools. |

---

## The five biggest challenges

### 1. No V2 listing exists anywhere

**Problem:** Tinyman's own analytics API doesn't have a "list all V2 pools" endpoint. Their UI uses internal endpoints we can't call. So we have to *discover* V2 addresses, one pool at a time.

**Mitigation:**
- Harvest `v2_address` fields from every V1 pool row (covers legacy pairs)
- Fetch top 100 assets by TVL from Vestige, then query Vestige for each asset's V2 pool with ALGO and USDC

**Still missed:** Brand-new tokens that just launched and aren't in Vestige's top 100 yet.

---

### 2. Vestige sorts pools by creation date, not TVL

**Problem:** When we ask Vestige "give me all pools for token X," it returns the *newest* pools first. The real, well-funded pool is often buried below 10+ junk pools created by spammers.

**Mitigation:** Instead of asking for "all pools with asset X," we ask for the **exact pair** — `asset_1_id=X & asset_2_id=0` (ALGO) and `asset_1_id=X & asset_2_id=31566704` (USDC). This returns only matching pools, no spam.

**Still missed:** Pools paired with other tokens (e.g. FOLKS/PHEZZIES, FOLKS/HOG) require knowing the second asset in advance. We don't enumerate those.

---

### 3. Both APIs rate-limit hard

**Problem:** Tinyman analytics returns 429 (Too Many Requests) after ~10 rapid calls. Vestige also rate-limits, just less aggressively. Scanning 200+ V2 pool addresses against Tinyman analytics is exactly the pattern they want to block.

**Mitigation:**
- Bounded concurrency (max 2 Tinyman calls in flight at once)
- 150ms delay between calls (~13 req/sec ceiling, under their threshold)
- Exponential backoff on 429: 800ms → 1.6s → 3.2s → 6.4s → 12.8s
- 24-hour cache of "dead" addresses (404s) so we skip them on next scan
- 30-minute cache of the final result — most visitors never trigger a scan

**Still impacts:** First-ever visitor in a 30-min window waits ~10-30 seconds for the full scan. We mitigate this with **progressive rendering** — V1 and Pact pools paint in <1s while V2 fills in.

---

### 4. Pact's API ignores its own `ordering` parameter

**Problem:** We tried `?ordering=-apr_7d` to get high-APR Pact pools first. The API silently ignores it and returns by TVL desc. Pools like HOG/FOLKS (26% APR, $2.6K TVL) sit at index ~77 in the response, past our default limit.

**Mitigation:** Fetch top 500 by TVL, filter `tvl > $1000 && apr > 0`, sort client-side by APR, take top 20.

**Still missed:** Pact pools with TVL below ~$1000 — but those are too thin to matter for real users.

---

### 5. APY values can look "wrong" because there are three different numbers

**Problem:** Tinyman shows three APY numbers per pool:
- `annual_percentage_rate` — just trading fees
- `staking_total_annual_percentage_yield` — staking + governance rewards on top
- `total_annual_percentage_yield` — everything combined (this is what their UI shows)

We use `total_annual_percentage_yield` to match Tinyman's UI. But the value updates on Tinyman's side every few minutes, and our cache is 30 min, so values can drift by a few % between us and them.

Pact's `apr_7d` field is an APR, not APY — but for short-term liquidity it doesn't differ enough to matter visually.

**Mitigation:** None really — we can shorten the cache TTL but that means more rate-limit pressure and slower loads. 30 min is the current compromise.

---

## Why a specific pool might be missing (decision tree)

```
Is the pool I expect missing from Top Opportunities?
│
├── Is it Tinyman V1? ─── Should always work. Check the V1 listing call returned data.
│
├── Is it Tinyman V2 with ALGO or USDC?
│   ├── Is one side in Vestige's top-100 assets by TVL?
│   │   ├── YES → Should appear. If not, Tinyman analytics 429'd this address.
│   │   │         Wait 30 min and reload (cache will reset).
│   │   └── NO  → Token TVL too low to be in our scan. Token needs more liquidity
│   │             across all its pools to enter top 100.
│   │
├── Is it Tinyman V2 paired with a non-ALGO, non-USDC token?
│   └── Currently NOT covered. We only probe X/ALGO and X/USDC pairs.
│
└── Is it Pact?
    ├── TVL > $1000 and APR > 0? ─── Should appear. Top 500 fetched, sorted.
    └── TVL < $1000 or APR = 0?   ─── Filtered out as too thin.
```

---

## What would fix the remaining gaps?

| Gap | Real fix | Why we haven't |
|---|---|---|
| V2 pools with non-ALGO/USDC quote (FOLKS/PHEZZIES) | Enumerate every top asset × every other top asset (100² = 10K pairs) | Way too many API calls |
| New tokens not in Vestige top 100 | Use a separate "trending" feed | No such public API exists |
| Stale APY values | Cache TTL → 60s | Would re-scan constantly, get rate-limited |
| 404/429 noise in dev console | Move scanning to a backend cron job | Violates xGov "no backend" constraint |

The current architecture is the best trade-off we've found inside the **client-only, no-backend, free-tier-only** constraint.

---

## The honest summary

The site shows ~15 of the top ~25 highest-APY pools on Algorand at any time. The ones it misses are almost always:
1. Brand-new tokens (Vestige hasn't indexed yet)
2. Niche-niche pairings (token vs another community token)
3. Pools that 429'd during this visitor's scan window

For an open-source, client-only dashboard with zero backend cost, this is roughly the ceiling of what's possible. A small server-side aggregator (Cloudflare Worker + KV) would close most of these gaps — that's the natural next step if we ever break the "no backend" rule.

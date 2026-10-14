import algosdk from 'algosdk'
import { poolUtils } from '@tinymanorg/tinyman-js-sdk'

const INDEXER_BASE = 'https://mainnet-idx.algonode.cloud'
const ALGOD_BASE = 'https://mainnet-api.algonode.cloud'

const algodClient = new algosdk.Algodv2('', ALGOD_BASE, '')

// Batch USD prices from Vestige Labs API (denominated in USDC).
// Cached per asset ID with a short TTL so reloads don't hammer Vestige —
// their own edge cache is 60s, so we match that as the floor.
const USDC_ID = 31566704
const VESTIGE_API = 'https://api.vestigelabs.org'
const PRICE_CACHE_KEY = 'vestigePriceCache'
const PRICE_TTL_MS = 60_000
const _priceMemCache = new Map() // assetId -> { price, expires }

function loadPriceCache() {
  if (_priceMemCache.size > 0) return
  try {
    const raw = localStorage.getItem(PRICE_CACHE_KEY)
    if (!raw) return
    const now = Date.now()
    for (const [id, entry] of Object.entries(JSON.parse(raw))) {
      if (entry.expires > now) _priceMemCache.set(Number(id), entry)
    }
  } catch { /* ignore corrupt cache */ }
}

function savePriceCache() {
  try {
    const obj = {}
    for (const [id, entry] of _priceMemCache) obj[id] = entry
    localStorage.setItem(PRICE_CACHE_KEY, JSON.stringify(obj))
  } catch { /* quota full or storage unavailable */ }
}

async function getUsdPrices(assetIds) {
  loadPriceCache()
  const now = Date.now()
  const unique = [...new Set(assetIds)]
  const need = unique.filter(id => {
    const e = _priceMemCache.get(id)
    return !e || e.expires <= now
  })

  if (need.length > 0) {
    try {
      const url = `${VESTIGE_API}/assets/price?asset_ids=${need.join(',')}&denominating_asset_id=${USDC_ID}&network_id=0`
      const res = await fetch(url)
      if (res.ok) {
        const data = await res.json()
        const expires = Date.now() + PRICE_TTL_MS
        for (const row of data) {
          _priceMemCache.set(row.asset_id, { price: Number(row.price) || 0, expires })
        }
      }
    } catch { /* prices remain unknown */ }
    // Record misses as zero with same TTL to prevent hammering on unknown assets
    const expires = Date.now() + PRICE_TTL_MS
    for (const id of need) {
      if (!_priceMemCache.has(id) || _priceMemCache.get(id).expires <= now) {
        _priceMemCache.set(id, { price: 0, expires })
      }
    }
    savePriceCache()
  }

  return Object.fromEntries(assetIds.map(id => [id, _priceMemCache.get(id)?.price || 0]))
}

async function getAlgoUsdPrice() {
  const prices = await getUsdPrices([0])
  return prices[0]
}

async function getAllAssets(address) {
  const assets = []
  let nextToken = null
  do {
    const url = `${INDEXER_BASE}/v2/accounts/${address}/assets?limit=100${nextToken ? `&next=${nextToken}` : ''}`
    const res = await fetch(url)
    if (!res.ok) break
    const data = await res.json()
    assets.push(...(data.assets || []))
    nextToken = data['next-token'] || null
  } while (nextToken)
  return assets
}

async function getAssetInfo(assetId) {
  if (assetId === 0) return { name: 'Algorand', 'unit-name': 'ALGO', decimals: 6 }
  try {
    const res = await fetch(`${INDEXER_BASE}/v2/assets/${assetId}`)
    if (!res.ok) return null
    const data = await res.json()
    return data.asset?.params || null
  } catch { return null }
}

function formatUSD(amount) {
  if (amount >= 1_000_000) return '$' + (amount / 1_000_000).toFixed(1) + 'M'
  if (amount >= 1000) return '$' + (amount / 1000).toFixed(1) + 'K'
  if (amount >= 1) return '$' + amount.toFixed(2)
  if (amount > 0) return '<$0.01'
  return '$0'
}

const LP_UNIT_NAMES = ['TMPOOL11', 'TM1POOL', 'TMPOOL2', 'PLP', 'AF-POOL']

function isLpToken(unitName, name) {
  return LP_UNIT_NAMES.includes(unitName) || name.startsWith('TinymanPool') || name.includes('PACT LP')
}

// Look up a single LP token's pool data and return a position object (or null)
async function lookupPool(lp) {
  // Tinyman V2
  if (lp.unitName === 'TMPOOL2' || lp.name.startsWith('TinymanPool2')) {
    try {
      const lpInfo = await getAssetInfo(lp.assetId)
      const poolAddr = lpInfo?.reserve
      if (!poolAddr) return null

      const poolAssets = await poolUtils.v2.getPoolAssets({
        client: algodClient, address: poolAddr, network: 'mainnet'
      })
      if (!poolAssets) return null

      const asset1ID = Number(poolAssets.asset1ID)
      const asset2ID = Number(poolAssets.asset2ID)
      const pool = await poolUtils.v2.getPoolInfo({
        client: algodClient, network: 'mainnet', asset1ID, asset2ID
      })
      const reserves = await poolUtils.v2.getPoolReserves(algodClient, pool)
      const share = poolUtils.getPoolShare(reserves.issuedLiquidity, BigInt(lp.amount))

      // Get TVL and APR from analytics API using pool address
      const addr = pool.account.address().toString()
      const analyticsRes = await fetch(`${ANALYTICS_API}/pools/${addr}`)
      let tvl = 0, apr = 0, asset1Name = '?', asset2Name = '?'
      if (analyticsRes.ok) {
        const aData = await analyticsRes.json()
        tvl = Number(aData.liquidity_in_usd) || 0
        apr = Number(aData.annual_percentage_rate) || 0
        asset1Name = aData.asset_1?.unit_name || aData.asset_1?.name || '?'
        asset2Name = aData.asset_2?.unit_name || aData.asset_2?.name || '?'
      } else {
        // Fallback to on-chain names
        const [info1, info2] = await Promise.all([getAssetInfo(asset1ID), getAssetInfo(asset2ID)])
        asset1Name = info1?.['unit-name'] || info1?.name || '?'
        asset2Name = info2?.['unit-name'] || info2?.name || '?'
      }
      const usdValue = tvl * share

      return {
        protocol: 'Tinyman V2', poolId: lp.assetId,
        asset1: asset1Name, asset2: asset2Name,
        share, usdValue, tvl, apr,
      }
    } catch (e) {
      console.error('Tinyman V2 pool error:', e)
      return null
    }
  }

  // Pact — on-chain lookup via LP token's reserve address
  if (lp.unitName === 'PLP' || lp.name.includes('PACT LP')) {
    try {
      const lpInfo = await getAssetInfo(lp.assetId)
      const poolAddr = lpInfo?.reserve || lpInfo?.creator
      if (!poolAddr) return null

      const res = await fetch(`${INDEXER_BASE}/v2/accounts/${poolAddr}/assets`)
      if (!res.ok) return null
      const data = await res.json()
      const holdings = data.assets || []

      const reserves = []
      let circulatingLp = 0
      for (const h of holdings) {
        if (h['asset-id'] === lp.assetId) {
          const totalSupply = BigInt(lpInfo.total || 0)
          circulatingLp = Number(totalSupply - BigInt(h.amount))
        } else if (h.amount > 0) {
          reserves.push({ assetId: h['asset-id'], amount: h.amount })
        }
      }

      if (circulatingLp <= 0 || reserves.length < 2) return null
      const share = lp.amount / circulatingLp

      const [info1, info2] = await Promise.all([getAssetInfo(reserves[0].assetId), getAssetInfo(reserves[1].assetId)])
      const dec1 = info1?.decimals || 0
      const dec2 = info2?.decimals || 0

      // Batch-price both reserve assets in a single Vestige request
      const prices = await getUsdPrices([reserves[0].assetId, reserves[1].assetId])
      const tvl = (reserves[0].amount / Math.pow(10, dec1)) * prices[reserves[0].assetId]
              + (reserves[1].amount / Math.pow(10, dec2)) * prices[reserves[1].assetId]
      const usdValue = tvl * share

      return {
        protocol: 'Pact', poolId: lp.assetId,
        asset1: info1?.['unit-name'] || info1?.name || '?',
        asset2: info2?.['unit-name'] || info2?.name || '?',
        share, usdValue, tvl, apr: 0,
      }
    } catch (e) {
      console.error('Pact pool error:', e)
      return null
    }
  }

  return null
}

// Cache LP token IDs in localStorage
const LP_CACHE_KEY = 'lpTokenCache'

function getCachedLpTokens(addresses) {
  try {
    const raw = localStorage.getItem(LP_CACHE_KEY)
    if (!raw) return null
    const cache = JSON.parse(raw)
    const key = addresses.sort().join(',')
    if (cache.key !== key) return null
    return cache.tokens
  } catch { return null }
}

function setCachedLpTokens(addresses, tokens) {
  const key = addresses.sort().join(',')
  localStorage.setItem(LP_CACHE_KEY, JSON.stringify({ key, tokens }))
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// Discover LP tokens from on-chain data
async function discoverLpTokens(addresses) {
  const lpTokens = []
  for (const address of addresses) {
    const assets = await getAllAssets(address)
    // Filter: must have balance, not deleted, skip likely NFTs (amount=1)
    const held = assets.filter(a => a.amount > 1 && !a.deleted)
    for (let i = 0; i < held.length; i += 10) {
      const batch = held.slice(i, i + 10)
      const infos = await Promise.all(batch.map(a => getAssetInfo(a['asset-id'])))
      for (let j = 0; j < batch.length; j++) {
        const info = infos[j]
        if (!info) continue
        const unitName = (info['unit-name'] || '').toUpperCase()
        const name = info.name || ''
        if (!isLpToken(unitName, name)) continue
        lpTokens.push({
          assetId: batch[j]['asset-id'],
          amount: batch[j].amount,
          unitName, name,
          decimals: info.decimals || 0,
        })
      }
      // Throttle to avoid 429s
      if (i + 10 < held.length) await sleep(100)
    }
  }
  return lpTokens
}

export async function fetchPositions(addresses, onPosition) {
  const positions = []
  function addPosition(pos) {
    const existing = positions.find(p => p.poolId === pos.poolId)
    if (existing) {
      existing.share += pos.share
      existing.usdValue += pos.usdValue
    } else {
      positions.push(pos)
    }
    onPosition?.([...positions])
  }

  // Pre-warm
  getAlgoUsdPrice()

  // Try cached LP tokens first for instant results
  const cached = getCachedLpTokens(addresses)
  if (cached && cached.length > 0) {
    // Get fresh balances for cached LP tokens
    const freshBalances = {}
    await Promise.all(addresses.map(async (addr) => {
      for (const lp of cached) {
        try {
          const res = await fetch(`${INDEXER_BASE}/v2/accounts/${addr}/assets?asset-id=${lp.assetId}`)
          if (!res.ok) continue
          const data = await res.json()
          const holding = data.assets?.[0]
          if (holding && holding.amount > 0 && !holding.deleted) {
            freshBalances[lp.assetId] = (freshBalances[lp.assetId] || 0) + holding.amount
          }
        } catch {}
      }
    }))

    // Look up all cached pools in parallel
    await Promise.all(cached.map(async (lp) => {
      const amount = freshBalances[lp.assetId]
      if (!amount) return
      const pos = await lookupPool({ ...lp, amount })
      if (pos) addPosition(pos)
    }))
  }

  // Discover LP tokens — await on first load, background if we have cache
  const doDiscovery = async () => {
    const freshLpTokens = await discoverLpTokens(addresses)
    setCachedLpTokens(addresses, freshLpTokens)

    const shownIds = new Set(positions.map(p => p.poolId))
    const newLps = freshLpTokens.filter(lp => !shownIds.has(lp.assetId))
    if (newLps.length === 0) return

    await Promise.all(newLps.map(async (lp) => {
      const pos = await lookupPool(lp)
      if (pos) addPosition(pos)
    }))
  }

  if (cached && cached.length > 0) {
    // Cache hit — re-discover in background
    doDiscovery()
  } else {
    // No cache — must await discovery
    await doDiscovery()
  }

  return positions
}

const ANALYTICS_API = 'https://mainnet.analytics.tinyman.org/api/v1'

// Top Opportunities result cache. The full scan (especially V2 discovery) is
// expensive — hundreds of analytics fetches — so we cache the final ranked list
// in localStorage and let the first visitor per TTL window do the work.
const TOP_POOLS_CACHE_KEY = 'topPoolsCache_v13'
const TOP_POOLS_TTL_MS = 30 * 60_000 // 30 min — APY/TVL don't move fast

function loadTopPoolsCache() {
  try {
    const raw = localStorage.getItem(TOP_POOLS_CACHE_KEY)
    if (!raw) return null
    const { expires, pools } = JSON.parse(raw)
    if (expires > Date.now()) return pools
  } catch {}
  return null
}

function saveTopPoolsCache(pools) {
  try {
    localStorage.setItem(TOP_POOLS_CACHE_KEY, JSON.stringify({
      expires: Date.now() + TOP_POOLS_TTL_MS, pools,
    }))
  } catch {}
}

// Bounded-concurrency map with optional per-worker delay. Limits parallel
// fetches so we don't get rate-limited by the analytics API or Algonode indexer.
async function mapPool(items, fn, concurrency = 10, delayMs = 0) {
  const results = new Array(items.length)
  let cursor = 0
  const workers = Array.from({ length: concurrency }, async () => {
    while (cursor < items.length) {
      const i = cursor++
      results[i] = await fn(items[i])
      if (delayMs && cursor < items.length) {
        await new Promise(r => setTimeout(r, delayMs))
      }
    }
  })
  await Promise.all(workers)
  return results
}

// Discover V2 pool addresses via Vestige: fetch top-N assets by TVL, then for
// each, query Vestige for its Tinyman-V2 pools. This catches pools for tokens
// that never had a V1 counterpart (FOLKS, GONNA, HAY, PHEZZIES, HOG, ...).
async function discoverV2AddressesFromVestige() {
  const addrSet = new Set()
  try {
    const assetRes = await fetch(
      `${VESTIGE_API}/assets/list?network_id=0&limit=100&order_by=tvl&order_dir=desc&denominating_asset_id=${USDC_ID}`
    )
    if (!assetRes.ok) return []
    const data = await assetRes.json()
    const rows = Array.isArray(data) ? data : (data.results || [])
    const assetIds = rows.map(a => a.id).filter(id => id && id !== 0 && id !== USDC_ID)

    // Vestige orders pools by creation date (newest first), so querying just
    // `asset_1_id=X` buries the real pairs under newer junk pools. Query the
    // specific asset-pair combos we care about (X + ALGO, X + USDC) — higher
    // asset ID is always asset_1, ALGO (0) and USDC are the common quote sides.
    await mapPool(assetIds, async (id) => {
      const pairs = [
        { asset_1_id: id, asset_2_id: 0 },          // X / ALGO
        { asset_1_id: id, asset_2_id: USDC_ID },    // X / USDC (if X > USDC)
        { asset_1_id: USDC_ID, asset_2_id: id < USDC_ID ? id : null }, // USDC / X (if X < USDC)
      ].filter(p => p.asset_2_id !== null)

      for (const pair of pairs) {
        try {
          const r = await fetchVestige(
            `${VESTIGE_API}/pools?network_id=0&provider_id=2&asset_1_id=${pair.asset_1_id}&asset_2_id=${pair.asset_2_id}`
          )
          if (!r.ok) continue
          const d = await r.json()
          for (const p of d.results || []) {
            if (!p.address) continue
            if (!p.asset_1_supply || !p.asset_2_supply) continue
            if (Number(p.asset_1_supply) < 100 || Number(p.asset_2_supply) < 100) continue
            addrSet.add(p.address)
          }
        } catch {}
      }
    }, 3, 100)
  } catch {}
  return [...addrSet]
}

// Fetch with retry-on-429. Tinyman analytics rate-limits aggressive scans.
// 404s (Tinyman's analytics doesn't index every V2 pool Vestige returns) and
// 429s are both expected edge cases — the caller just treats them as misses.
// Generic fetch with 429 retry + exponential backoff. Used for both Tinyman
// analytics and Vestige pools — both rate-limit aggressive clients.
async function fetchWithRetry(url, maxRetries = 5, baseMs = 800) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let res
    try { res = await fetch(url) }
    catch { return { ok: false, status: 0, json: async () => ({}) } }
    if (res.status === 429) {
      const delay = baseMs * Math.pow(2, attempt) + Math.random() * 400
      await new Promise(r => setTimeout(r, delay))
      continue
    }
    return res
  }
  return { ok: false, status: 429, json: async () => ({}) }
}

const fetchAnalytics = (url) => fetchWithRetry(url, 5, 800)
const fetchVestige = (url) => fetchWithRetry(url, 4, 500)

// Returns the pool, null for a miss, or NOT_FOUND when Tinyman analytics
// doesn't index the address at all (404) — only that case is safe to skip.
const NOT_FOUND = Symbol('notFound')

async function fetchV2PoolByAddress(poolAddr) {
  try {
    const res = await fetchAnalytics(`${ANALYTICS_API}/pools/${poolAddr}/`)
    if (res.status === 404) return NOT_FOUND
    if (!res.ok) return null
    const data = await res.json()
    const apy = Number(data.total_annual_percentage_yield) || 0
    const tvl = Number(data.liquidity_in_usd) || 0
    if (tvl < 1000 || apy <= 0) return null
    const a1 = data.asset_1?.unit_name || '?'
    const a2 = data.asset_2?.unit_name || '?'
    return {
      pair: `${a1} / ${a2}`, apy, tvl, platform: 'Tinyman V2',
      url: `https://app.tinyman.org/pool/${poolAddr}`,
    }
  } catch { return null }
}

// Dead-address cache: pool addresses that returned 404 from Tinyman analytics.
// These never come back, so we skip them on subsequent scans.
const DEAD_ADDRS_KEY = 'topPoolsDeadAddrs_v2' // v1 wrongly held transient failures
const DEAD_ADDRS_TTL_MS = 24 * 60 * 60_000 // 24 hours

function loadDeadAddrs() {
  try {
    const raw = localStorage.getItem(DEAD_ADDRS_KEY)
    if (!raw) return new Set()
    const { expires, addrs } = JSON.parse(raw)
    if (expires > Date.now()) return new Set(addrs)
  } catch {}
  return new Set()
}
function saveDeadAddrs(set) {
  try {
    localStorage.setItem(DEAD_ADDRS_KEY, JSON.stringify({
      expires: Date.now() + DEAD_ADDRS_TTL_MS,
      addrs: [...set],
    }))
  } catch {}
}

// Dedupe concurrent calls (React StrictMode double-invokes effects in dev,
// and re-renders can trigger the same fetch multiple times in prod too).
let _topPoolsInflight = null

// fetchTopPools takes an optional onUpdate callback that fires each time new
// pools are merged in, letting the UI render V1 + Pact instantly (<1s) while
// V2 pools trickle in progressively over the following 10-30s.
export async function fetchTopPools(onUpdate) {
  const cached = loadTopPoolsCache()
  if (cached) {
    onUpdate?.(cached)
    return cached
  }
  if (_topPoolsInflight) return _topPoolsInflight
  _topPoolsInflight = _fetchTopPoolsImpl(onUpdate)
    .finally(() => { _topPoolsInflight = null })
  return _topPoolsInflight
}

// Merge a batch of pools into the running list, resort, take top 15, emit.
function _emit(pools, onUpdate) {
  pools.sort((a, b) => b.apy - a.apy)
  onUpdate?.(pools.slice(0, 15))
}

async function _fetchTopPoolsImpl(onUpdate) {
  const pools = []
  const v2Addrs = []
  const deadAddrs = loadDeadAddrs()

  // Kick off V1, Pact, and Vestige asset discovery in parallel — all three
  // are single-request flows, so they race to first-paint.

  const v1Promise = (async () => {
    try {
      const res = await fetch(`${ANALYTICS_API}/pools/?limit=200&ordering=-liquidity_in_usd`)
      if (!res.ok) return
      const data = await res.json()
      ;(data.results || []).forEach(p => {
        if (p.v2_address) v2Addrs.push(p.v2_address)
        const apy = Number(p.total_annual_percentage_yield) || 0
        const tvl = Number(p.liquidity_in_usd) || 0
        if (tvl < 1000 || apy <= 0) return
        const a1 = p.asset_1?.unit_name || '?'
        const a2 = p.asset_2?.unit_name || '?'
        pools.push({
          pair: `${a1} / ${a2}`, apy, tvl, platform: 'Tinyman V1',
          url: p.address ? `https://app.tinyman.org/pool/${p.address}` : null,
        })
      })
      _emit(pools, onUpdate)
    } catch {}
  })()

  const pactPromise = (async () => {
    try {
      const res = await fetch('https://api.pact.fi/api/pools?limit=500')
      if (!res.ok) return
      const data = await res.json()
      const pactPools = (data.results || [])
        .filter(p => Number(p.tvl_usd) > 1000 && Number(p.apr_7d) > 0)
        .sort((a, b) => Number(b.apr_7d) - Number(a.apr_7d))
        .slice(0, 20)
      for (const p of pactPools) {
        const pair = `${p.primary_asset?.unit_name || '?'} / ${p.secondary_asset?.unit_name || '?'}`
        if (pools.some(ep => ep.pair === pair && ep.platform === 'Pact')) continue
        pools.push({
          pair,
          apy: Number(p.apr_7d) || 0,
          tvl: Number(p.tvl_usd) || 0,
          platform: 'Pact',
          url: p.on_chain_id ? `https://app.pact.fi/add-liquidity/${p.on_chain_id}` : null,
        })
      }
      _emit(pools, onUpdate)
    } catch {}
  })()

  const vestigePromise = discoverV2AddressesFromVestige().catch(() => [])

  // Wait for V1 + Pact (both fast) so user sees populated UI ASAP.
  await Promise.all([v1Promise, pactPromise])

  // Now drain V2 addresses progressively. Tinyman analytics is slow + rate-
  // limited, so we emit after every successful hit.
  try {
    const vestigeAddrs = await vestigePromise
    const allV2 = [...new Set([...v2Addrs, ...vestigeAddrs])]
      .filter(addr => !deadAddrs.has(addr))

    let emitCounter = 0
    await mapPool(allV2, async (addr) => {
      const pool = await fetchV2PoolByAddress(addr)
      if (pool === NOT_FOUND) {
        // Only 404s are permanent. Rate limits, network errors, and low-TVL
        // pools are transient, so they get retried on the next scan.
        deadAddrs.add(addr)
      } else if (pool) {
        pools.push(pool)
        // Emit every 3 successful hits to avoid UI thrash
        if (++emitCounter % 3 === 0) _emit(pools, onUpdate)
      }
    }, 2, 150)
    saveDeadAddrs(deadAddrs)
  } catch {}

  _emit(pools, onUpdate)
  pools.sort((a, b) => b.apy - a.apy)
  const top = pools.slice(0, 15)
  if (top.length > 0) saveTopPoolsCache(top)
  return top
}

export { formatUSD }

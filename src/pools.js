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

// Candidate tokens for V2 ALGO pool discovery. Tinyman Analytics' listing
// endpoint only returns V1 pools, so we derive V2 pool addresses via the SDK
// for each token, then query the analytics API per-address for 7D APY data.
const V2_CANDIDATE_TOKENS = [
  287867876,   // OPUL
  3203964481,  // FOLKS
  2582294183,  // GONNA
  1058926737,  // WBTC (xBacked)
  386195940,   // goBTC
  386192725,   // goETH
  2751733,     // RIO
  31566704,    // USDC
  312769,      // USDt
  470842789,   // DEFLY
  523683256,   // AKTA
  1138500612,  // ORA
  796425061,   // coop
  283820866,   // XET
  567485181,   // LOUD
  226701642,   // YLDY
  1284444444,  // NIKO
  388592191,   // GARD
  793124631,   // gALGO
]

// Fetch a single Tinyman V2 pool's analytics (pair, APY, TVL)
async function fetchV2PoolStats(assetId) {
  try {
    const pool = await poolUtils.v2.getPoolInfo({
      client: algodClient, network: 'mainnet', asset1ID: assetId, asset2ID: 0,
    })
    if (pool.status !== 'ready') return null
    const addr = pool.account.address().toString()
    const res = await fetch(`${ANALYTICS_API}/pools/${addr}/`)
    if (!res.ok) return null
    const data = await res.json()
    const apy = Number(data.total_annual_percentage_yield) || 0
    const tvl = Number(data.liquidity_in_usd) || 0
    if (tvl < 500 || apy <= 0) return null
    const a1 = data.asset_1?.unit_name || '?'
    const a2 = data.asset_2?.unit_name || 'ALGO'
    return { pair: `${a1} / ${a2}`, apy, tvl, platform: 'Tinyman V2' }
  } catch { return null }
}

// Fetch top pools for opportunities section, ranked by 7D APY (incl. gov/staking rewards)
export async function fetchTopPools() {
  const pools = []

  // Tinyman V1 — listing endpoint returns pools sorted by TVL with full APY data.
  // Scan the top ~200 (by TVL) and keep any with meaningful APY.
  try {
    const res = await fetch(`${ANALYTICS_API}/pools/?limit=200`)
    if (res.ok) {
      const data = await res.json()
      ;(data.results || []).forEach(p => {
        const apy = Number(p.total_annual_percentage_yield) || 0
        const tvl = Number(p.liquidity_in_usd) || 0
        if (tvl < 1000 || apy <= 0) return
        const a1 = p.asset_1?.unit_name || '?'
        const a2 = p.asset_2?.unit_name || '?'
        pools.push({ pair: `${a1} / ${a2}`, apy, tvl, platform: 'Tinyman V1' })
      })
    }
  } catch {}

  // Tinyman V2 — not in the listing endpoint; must derive each pool address via
  // SDK then query analytics by address. Uses a curated token whitelist.
  const v2 = await Promise.all(V2_CANDIDATE_TOKENS.map(fetchV2PoolStats))
  pools.push(...v2.filter(Boolean))

  // Pact — direct API listing (supports APR ordering)
  try {
    const res = await fetch('https://api.pact.fi/api/pools?limit=15&ordering=-apr_7d&is_verified=true')
    if (res.ok) {
      const data = await res.json()
      ;(data.results || [])
        .filter(p => Number(p.tvl_usd) > 1000 && Number(p.apr_7d) > 0)
        .forEach(p => {
          const pair = `${p.primary_asset?.unit_name || '?'} / ${p.secondary_asset?.unit_name || '?'}`
          if (pools.some(ep => ep.pair === pair && ep.platform === 'Pact')) return
          pools.push({
            pair,
            apy: Number(p.apr_7d) || 0,
            tvl: Number(p.tvl_usd) || 0,
            platform: 'Pact',
          })
        })
    }
  } catch {}

  // Sort by APY descending, return top 15
  pools.sort((a, b) => b.apy - a.apy)
  return pools.slice(0, 15)
}

export { formatUSD }

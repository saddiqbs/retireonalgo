import algosdk from 'algosdk'
import { poolUtils } from '@tinymanorg/tinyman-js-sdk'

const INDEXER_BASE = 'https://mainnet-idx.algonode.cloud'
const ALGOD_BASE = 'https://mainnet-api.algonode.cloud'

const algodClient = new algosdk.Algodv2('', ALGOD_BASE, '')

// Get ALGO/USD price from CoinGecko (cached for session)
let _algoUsdCache = null
async function getAlgoUsdPrice() {
  if (_algoUsdCache !== null) return _algoUsdCache
  try {
    const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=algorand&vs_currencies=usd')
    if (!res.ok) return 0
    const data = await res.json()
    _algoUsdCache = data.algorand?.usd || 0
    return _algoUsdCache
  } catch { return 0 }
}

// Get asset price in USD via its Tinyman V2 ALGO pool
async function getAssetUsdPrice(assetId, decimals, algoUsd) {
  if (assetId === 0) return algoUsd
  try {
    const pool = await poolUtils.v2.getPoolInfo({
      client: algodClient, network: 'mainnet', asset1ID: assetId, asset2ID: 0
    })
    if (pool.status !== 'ready') return 0
    const res = await poolUtils.v2.getPoolReserves(algodClient, pool)
    const assetAmount = Number(res.asset1) / Math.pow(10, decimals)
    const algoAmount = Number(res.asset2) / 1e6
    if (assetAmount <= 0) return 0
    return (algoAmount / assetAmount) * algoUsd
  } catch { return 0 }
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

      const [info1, info2] = await Promise.all([getAssetInfo(asset1ID), getAssetInfo(asset2ID)])
      const dec1 = info1?.decimals || 0
      const dec2 = info2?.decimals || 0

      const algoUsd = await getAlgoUsdPrice()
      const [price1, price2] = await Promise.all([
        getAssetUsdPrice(asset1ID, dec1, algoUsd),
        getAssetUsdPrice(asset2ID, dec2, algoUsd)
      ])
      const tvl = (Number(reserves.asset1) / Math.pow(10, dec1)) * price1
              + (Number(reserves.asset2) / Math.pow(10, dec2)) * price2
      const usdValue = tvl * share

      return {
        protocol: 'Tinyman V2', poolId: lp.assetId,
        asset1: info1?.['unit-name'] || info1?.name || '?',
        asset2: info2?.['unit-name'] || info2?.name || '?',
        share, usdValue, tvl, apr: 0,
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

      const algoUsd = await getAlgoUsdPrice()
      const [price1, price2] = await Promise.all([
        getAssetUsdPrice(reserves[0].assetId, dec1, algoUsd),
        getAssetUsdPrice(reserves[1].assetId, dec2, algoUsd)
      ])
      const tvl = (reserves[0].amount / Math.pow(10, dec1)) * price1
              + (reserves[1].amount / Math.pow(10, dec2)) * price2
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

// Discover LP tokens from on-chain data
async function discoverLpTokens(addresses) {
  const lpTokens = []
  for (const address of addresses) {
    const assets = await getAllAssets(address)
    const held = assets.filter(a => a.amount > 0 && !a.deleted)
    for (let i = 0; i < held.length; i += 30) {
      const batch = held.slice(i, i + 30)
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

export { formatUSD }

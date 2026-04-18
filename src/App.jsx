import { useState, useEffect } from 'react'
import { WalletManager, WalletId, NetworkId } from '@txnlab/use-wallet'
import { fetchPositions, fetchTopPools, formatUSD } from './pools'

const RETIRE_ASA_ID = 2581523977
const RETIRE_DECIMALS = 6
const INDEXER_BASE = 'https://mainnet-idx.algonode.cloud'

const manager = new WalletManager({
  wallets: [{ id: WalletId.PERA, options: { shouldShowSignTxnToast: false } }],
  network: NetworkId.MAINNET
})

async function getRetireBalance(address) {
  try {
    const res = await fetch(`${INDEXER_BASE}/v2/accounts/${address}/assets?asset-id=${RETIRE_ASA_ID}`)
    if (!res.ok) return 0
    const data = await res.json()
    if (data.assets && data.assets.length > 0) {
      return data.assets[0].amount / Math.pow(10, RETIRE_DECIMALS)
    }
    return 0
  } catch { return 0 }
}

function formatBalance(amount) {
  if (amount >= 1_000_000_000) return (amount / 1_000_000_000).toFixed(1) + 'B'
  if (amount >= 1_000_000) return (amount / 1_000_000).toFixed(1) + 'M'
  if (amount >= 1_000) return (amount / 1_000).toFixed(1) + 'K'
  return amount.toFixed(2)
}

async function getNFDName(addr) {
  try {
    const res = await fetch(`https://api.nf.domains/nfd/lookup?address=${addr}&view=tiny`)
    if (!res.ok) return null
    const data = await res.json()
    const nfd = data[addr]
    return nfd ? nfd.name : null
  } catch { return null }
}

function shortAddress(addr) {
  return addr.slice(0, 6) + '...' + addr.slice(-4)
}

export default function App() {
  const [wallets, setWallets] = useState(() => {
  try {
    const saved = localStorage.getItem('connectedWallets')
    if (!saved) return []
    const parsed = JSON.parse(saved)
    return parsed.filter(w => w && typeof w === 'object' && w.address && w.name)
  } catch { return [] }
})
  const [isExpanded, setIsExpanded] = useState(false)
  const [retireBalance, setRetireBalance] = useState(null)
  const [positions, setPositions] = useState([])
  const [loadingPositions, setLoadingPositions] = useState(false)
  const [topPools, setTopPools] = useState([])
  const [showPoolCount, setShowPoolCount] = useState(3)

  useEffect(() => {
    // Don't clobber a populated list if a subsequent fetch returns empty
    // (transient analytics API failures shouldn't hide the section).
    fetchTopPools().then(pools => {
      if (pools && pools.length > 0) setTopPools(pools)
    })
  }, [])

  useEffect(() => {
    if (wallets.length === 0) {
      setRetireBalance(null)
      setPositions([])
      return
    }
    async function fetchBalances() {
      const balances = await Promise.all(wallets.map(w => getRetireBalance(w.address)))
      setRetireBalance(balances.reduce((sum, b) => sum + b, 0))
    }
    fetchBalances()

    setLoadingPositions(true)
    setPositions([])
    fetchPositions(wallets.map(w => w.address), setPositions)
      .catch(() => setPositions([]))
      .finally(() => setLoadingPositions(false))
  }, [wallets])

  function saveWallets(list) {
  localStorage.setItem('connectedWallets', JSON.stringify(list))
  setWallets(list)
}

  async function connectWallet() {
  try {
    await manager.resumeSessions()
    const wallet = manager.getWallet(WalletId.PERA)
    await wallet.connect()
    const accounts = wallet.accounts.map(a => a.address)
    const existing = wallets.map(w => w.address)
    const newAddrs = accounts.filter(a => !existing.includes(a))
    const newWallets = await Promise.all(newAddrs.map(async addr => ({
      address: addr,
      name: (await getNFDName(addr)) || shortAddress(addr)
    })))
    const updated = [...wallets, ...newWallets]
    saveWallets(updated)
  } catch (e) { console.error('Connect failed', e) }
}

  function removeWallet(addr) {
    const updated = wallets.filter(w => w.address !== addr)
    saveWallets(updated)
    if (updated.length === 0) {
      manager.getWallet(WalletId.PERA)?.disconnect()
      setIsExpanded(false)
    }
  }

  function disconnectAll() {
    localStorage.removeItem('connectedWallets')
    setWallets([])
    setIsExpanded(false)
    manager.getWallet(WalletId.PERA)?.disconnect()
  }
return (
    <div>
      <nav style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        flexWrap: 'wrap', gap: '10px', padding: '16px 24px',
        borderBottom: '0.5px solid #2a2840'
      }}>
        <div style={{ fontSize: '18px', fontWeight: 500, color: '#CECBF6' }}>
          $<span style={{ color: '#7F77DD' }}>Retire</span> on Algo
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          {wallets.length === 0 ? (
            <button onClick={connectWallet} style={{
              background: '#1a1830', border: '1px solid #534AB7', color: '#AFA9EC',
              padding: '8px 20px', borderRadius: '20px', fontSize: '14px', cursor: 'pointer'
           }}>Connect wallet</button>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              {retireBalance !== null && (
                <div style={{
                  background: retireBalance > 0 ? '#1a2830' : '#1e1e24',
                  border: `1px solid ${retireBalance > 0 ? '#2a7840' : '#3a3a42'}`,
                  padding: '6px 12px', borderRadius: '20px', fontSize: '13px',
                  color: retireBalance > 0 ? '#7FDD9F' : '#6b6b78'
                }}>
                  {retireBalance > 0
                    ? `${formatBalance(retireBalance)} $Retire`
                    : 'No $Retire'}
                </div>
              )}
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', cursor: 'pointer' }}
                onClick={() => setIsExpanded(!isExpanded)}>
                {wallets.map(w => (
                  <div key={w.address} style={{
                    display: 'flex', alignItems: 'center', gap: '8px',
                    background: '#1a1830', border: '1px solid #2a2840',
                    padding: '6px 12px', borderRadius: '20px', fontSize: '13px', color: '#7F77DD'
                  }}>
                    <span>{w.name}</span>
                    {isExpanded && (
                      <span onClick={(e) => { e.stopPropagation(); removeWallet(w.address) }}
                        style={{ color: '#534AB7', cursor: 'pointer', fontSize: '11px' }}>✕</span>
                    )}
                  </div>
                ))}
              </div>
              {isExpanded && (
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button onClick={connectWallet} style={{
                    background: '#1a1830', border: '1px solid #534AB7', color: '#AFA9EC',
                    padding: '6px 14px', borderRadius: '20px', fontSize: '13px', cursor: 'pointer'
                  }}>+ Add wallet</button>
                  <button onClick={disconnectAll} style={{
                    background: 'transparent', border: '1px solid #3a3060', color: '#534AB7',
                    padding: '6px 14px', borderRadius: '20px', fontSize: '13px', cursor: 'pointer'
                  }}>Disconnect all</button>
                </div>
              )}
            </div>
          )}
        </div>
      </nav>
      <div style={{ maxWidth: '1000px', margin: '0 auto', padding: '40px 24px' }}>
        {wallets.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '80px 24px' }}>
            <h1 style={{ fontSize: '32px', fontWeight: 500, color: '#CECBF6', marginBottom: '12px' }}>
              Your Algorand DeFi dashboard
            </h1>
            <p style={{ fontSize: '15px', color: '#534AB7', lineHeight: 1.7, maxWidth: '400px', margin: '0 auto' }}>
              Connect your Pera wallet to see your positions, earnings, and the best pool opportunities on Algorand.
            </p>
          </div>
        ) : (
          <div>
            {/* Summary Strip */}
            <div style={{
              display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
              gap: '12px', marginBottom: '32px'
            }}>
              {[
                { label: 'Total Value', value: formatUSD(positions.reduce((s, p) => s + p.usdValue, 0)), color: '#CECBF6' },
                { label: 'Active Pools', value: positions.length, color: '#7F77DD' },
                { label: '$Retire Held', value: retireBalance !== null ? formatBalance(retireBalance) : '...', color: retireBalance > 0 ? '#7FDD9F' : '#6b6b78' },
              ].map((stat, i) => (
                <div key={i} style={{
                  background: '#12111f', border: '1px solid #2a2840', borderRadius: '12px',
                  padding: '16px 20px', textAlign: 'center'
                }}>
                  <div style={{ fontSize: '11px', color: '#534AB7', marginBottom: '6px' }}>{stat.label}</div>
                  <div style={{ fontSize: '20px', fontWeight: 600, color: stat.color }}>{stat.value}</div>
                </div>
              ))}
            </div>

            <h2 style={{ fontSize: '20px', fontWeight: 500, color: '#CECBF6', marginBottom: '20px' }}>
              My Positions
            </h2>
            {loadingPositions ? (
              <div style={{ textAlign: 'center', padding: '40px', color: '#534AB7' }}>
                Loading positions...
              </div>
            ) : positions.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '40px', color: '#534AB7', fontSize: '14px' }}>
                No liquidity pool positions found
              </div>
            ) : (
              <div style={{ display: 'grid', gap: '12px' }}>
                {positions.map(p => (
                  <div key={`${p.protocol}-${p.poolId}`} style={{
                    background: '#12111f', border: '1px solid #2a2840', borderRadius: '12px',
                    padding: '16px 20px', display: 'flex', alignItems: 'center',
                    justifyContent: 'space-between', flexWrap: 'wrap', gap: '12px'
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                      <span style={{
                        fontSize: '11px', color: '#AFA9EC', background: '#1a1830',
                        border: '1px solid #2a2840', padding: '2px 8px', borderRadius: '6px'
                      }}>{p.protocol}</span>
                      <span style={{ fontSize: '15px', fontWeight: 500, color: '#CECBF6' }}>
                        {p.asset1} / {p.asset2}
                      </span>
                    </div>
                    <div style={{ display: 'flex', gap: '24px', flexWrap: 'wrap' }}>
                      <div style={{ textAlign: 'right' }}>
                        <div style={{ fontSize: '11px', color: '#534AB7', marginBottom: '2px' }}>Your Value</div>
                        <div style={{ fontSize: '15px', fontWeight: 500, color: '#CECBF6' }}>
                          {formatUSD(p.usdValue)}
                        </div>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <div style={{ fontSize: '11px', color: '#534AB7', marginBottom: '2px' }}>Pool TVL</div>
                        <div style={{ fontSize: '14px', color: '#7F77DD' }}>
                          {formatUSD(p.tvl)}
                        </div>
                      </div>
                      {p.apr > 0 && (
                        <div style={{ textAlign: 'right' }}>
                          <div style={{ fontSize: '11px', color: '#534AB7', marginBottom: '2px' }}>APY</div>
                          <div style={{ fontSize: '14px', color: '#7FDD9F' }}>
                            {((Math.pow(1 + p.apr / 365, 365) - 1) * 100).toFixed(1)}%
                          </div>
                        </div>
                      )}
                      <div style={{ textAlign: 'right' }}>
                        <div style={{ fontSize: '11px', color: '#534AB7', marginBottom: '2px' }}>Share</div>
                        <div style={{ fontSize: '14px', color: '#7F77DD' }}>
                          {(p.share * 100).toFixed(2)}%
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        {/* Top Opportunities */}
        {topPools.length > 0 && (
          <div style={{ marginTop: '48px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '20px' }}>
              <h2 style={{ fontSize: '20px', fontWeight: 500, color: '#CECBF6', margin: 0 }}>
                Top Opportunities
              </h2>
              <span style={{ fontSize: '11px', color: '#1a2830', background: '#7FDD9F',
                padding: '3px 10px', borderRadius: '10px', fontWeight: 600 }}>
                $RETIRE HOLDERS ONLY
              </span>
            </div>
            <div style={{
              position: 'relative',
              display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '12px',
              ...(retireBalance <= 0 ? { filter: 'blur(6px)', pointerEvents: 'none', userSelect: 'none' } : {})
            }}>
              {topPools.slice(0, showPoolCount).map((pool, i) => (
                <div key={i} style={{
                  background: '#12111f', border: '1px solid #2a2840', borderRadius: '12px',
                  padding: '20px', display: 'flex', flexDirection: 'column', gap: '12px'
                }}>
                  <div style={{ fontSize: '15px', fontWeight: 500, color: '#CECBF6' }}>{pool.pair}</div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <div>
                      <div style={{ fontSize: '11px', color: '#534AB7', marginBottom: '2px' }}>APY</div>
                      <div style={{ fontSize: '18px', fontWeight: 600, color: '#7FDD9F' }}>
                        {(pool.apy * 100).toFixed(1)}%
                      </div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontSize: '11px', color: '#534AB7', marginBottom: '2px' }}>TVL</div>
                      <div style={{ fontSize: '14px', color: '#7F77DD' }}>{formatUSD(pool.tvl)}</div>
                    </div>
                  </div>
                  <div style={{ fontSize: '11px', color: '#534AB7' }}>via {pool.platform}</div>
                </div>
              ))}
            </div>
            {retireBalance > 0 && showPoolCount < topPools.length && (
              <div style={{ textAlign: 'center', marginTop: '16px' }}>
                <button onClick={() => setShowPoolCount(prev => Math.min(prev === 3 ? 9 : 15, topPools.length))}
                  style={{
                    background: '#1a1830', border: '1px solid #2a2840', color: '#7F77DD',
                    padding: '8px 24px', borderRadius: '20px', fontSize: '13px', cursor: 'pointer'
                  }}>
                  Show more pools
                </button>
              </div>
            )}
            {retireBalance <= 0 && (
              <div style={{
                textAlign: 'center', marginTop: '-80px', position: 'relative', zIndex: 1,
                padding: '20px', color: '#7F77DD', fontSize: '14px'
              }}>
                Hold $Retire to unlock top opportunities
              </div>
            )}
          </div>
        )}

        {/* Get $Retire Section */}
        <div style={{ marginTop: '48px' }}>
          <h2 style={{ fontSize: '20px', fontWeight: 500, color: '#CECBF6', marginBottom: '20px' }}>
            Get $Retire
          </h2>
          <div style={{
            background: '#12111f', border: '1px solid #2a2840', borderRadius: '12px',
            padding: '28px', display: 'flex', flexWrap: 'wrap', gap: '28px',
            alignItems: 'center', justifyContent: 'space-between'
          }}>
            <div style={{ flex: '1 1 280px' }}>
              <p style={{ fontSize: '15px', color: '#CECBF6', margin: '0 0 16px 0', lineHeight: 1.6 }}>
                Hold $Retire to unlock exclusive pool insights and be part of the Algorand DeFi community.
              </p>
              <ul style={{ margin: 0, padding: '0 0 0 18px', color: '#7F77DD', fontSize: '13px', lineHeight: 2 }}>
                <li>Unlock Top Opportunities section</li>
                <li>Access curated high-APY pool data</li>
                <li>Support the Algorand DeFi ecosystem</li>
              </ul>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', flex: '0 0 auto' }}>
              <a href="https://app.tinyman.org/#/swap?asset_in=0&asset_out=2581523977"
                target="_blank" rel="noopener noreferrer" style={{
                  display: 'inline-block', background: '#534AB7', color: '#fff',
                  padding: '10px 28px', borderRadius: '20px', fontSize: '14px',
                  textDecoration: 'none', textAlign: 'center', fontWeight: 500
                }}>Swap on Tinyman</a>
              <a href="https://vestige.fi/asset/2581523977"
                target="_blank" rel="noopener noreferrer" style={{
                  display: 'inline-block', background: '#1a1830', border: '1px solid #534AB7',
                  color: '#AFA9EC', padding: '10px 28px', borderRadius: '20px', fontSize: '14px',
                  textDecoration: 'none', textAlign: 'center', fontWeight: 500
                }}>View on Vestige</a>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
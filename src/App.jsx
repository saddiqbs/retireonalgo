import { useState } from 'react'
import { WalletManager, WalletId, NetworkId } from '@txnlab/use-wallet'

const manager = new WalletManager({
  wallets: [{ id: WalletId.PERA, options: { shouldShowSignTxnToast: false } }],
  network: NetworkId.MAINNET
})

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
        <div style={{ textAlign: 'center', padding: '80px 24px' }}>
          <h1 style={{ fontSize: '32px', fontWeight: 500, color: '#CECBF6', marginBottom: '12px' }}>
            Your Algorand DeFi dashboard
          </h1>
          <p style={{ fontSize: '15px', color: '#534AB7', lineHeight: 1.7, maxWidth: '400px', margin: '0 auto' }}>
            Connect your Pera wallet to see your positions, earnings, and the best pool opportunities on Algorand.
          </p>
        </div>
      </div>
    </div>
  )
}
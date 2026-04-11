import { WalletManager, WalletId } from '@txnlab/use-wallet'

const manager = new WalletManager({
  wallets: [WalletId.PERA]
})

const connectBtn = document.getElementById('connect-btn')
const walletInfo = document.getElementById('wallet-info')
const walletsContainer = document.getElementById('wallets-container')
const disconnectAllBtn = document.getElementById('disconnect-all-btn')

let connectedWallets = []
let isExpanded = false

function saveWallets() {
  localStorage.setItem('connectedWallets', JSON.stringify(connectedWallets.map(w => w.address)))
}

function loadSavedWallets() {
  try {
    const saved = localStorage.getItem('connectedWallets')
    return saved ? JSON.parse(saved) : []
  } catch {
    return []
  }
}

function shortAddress(addr) {
  return addr.slice(0, 6) + '...' + addr.slice(-4)
}

async function getNFDName(addr) {
  try {
    const res = await fetch(`https://api.nf.domains/nfd/lookup?address=${addr}&view=tiny`)
    if (!res.ok) return null
    const data = await res.json()
    const nfd = data[addr]
    return nfd ? nfd.name : null
  } catch {
    return null
  }
}

function toggleExpanded() {
  isExpanded = !isExpanded
  if (isExpanded) {
    walletInfo.classList.add('wallet-expanded')
  } else {
    walletInfo.classList.remove('wallet-expanded')
  }
}

function removeWallet(addr) {
  connectedWallets = connectedWallets.filter(w => w.address !== addr)
  saveWallets()
  renderWallets()
  if (connectedWallets.length === 0) {
    walletInfo.style.display = 'none'
    walletInfo.classList.remove('wallet-expanded')
    isExpanded = false
    connectBtn.style.display = 'block'
  }
}

function renderWallets() {
  walletsContainer.innerHTML = ''
  connectedWallets.forEach(wallet => {
    const pill = document.createElement('div')
    pill.className = 'wallet-pill'
    pill.innerHTML = `
      <span class="wallet-name">${wallet.name}</span>
      <span class="wallet-remove" data-addr="${wallet.address}">✕</span>
    `
    pill.querySelector('.wallet-remove').addEventListener('click', (e) => {
      e.stopPropagation()
      removeWallet(wallet.address)
    })
    walletsContainer.appendChild(pill)
  })
}

async function addWallet(addr, shouldReload = false) {
  if (connectedWallets.find(w => w.address === addr)) return
  const nfdName = await getNFDName(addr)
  connectedWallets.push({ address: addr, name: nfdName || shortAddress(addr) })
  saveWallets()
  renderWallets()
  connectBtn.style.display = 'none'
  walletInfo.style.display = 'flex'
  if (shouldReload) window.location.reload()
}

function onDisconnectAll() {
  connectedWallets = []
  localStorage.removeItem('connectedWallets')
  walletsContainer.innerHTML = ''
  walletInfo.style.display = 'none'
  walletInfo.classList.remove('wallet-expanded')
  isExpanded = false
  connectBtn.style.display = 'block'
  manager.getWallet(WalletId.PERA)?.disconnect()
}

async function restoreWallets() {
  const saved = loadSavedWallets()
  for (const addr of saved) {
    await addWallet(addr)
  }
}

async function connectPera() {
  try {
    await manager.resumeSessions()
    const wallet = manager.getWallet(WalletId.PERA)
    await wallet.connect()
    const accounts = wallet.accounts.map(a => a.address)
    for (const addr of accounts) {
      await addWallet(addr, true)
    }
  } catch (e) {
    console.error('Connect failed', e)
  }
}

restoreWallets()
walletsContainer.addEventListener('click', toggleExpanded)
connectBtn.addEventListener('click', connectPera)
document.getElementById('add-wallet-btn').addEventListener('click', connectPera)
disconnectAllBtn.addEventListener('click', onDisconnectAll)
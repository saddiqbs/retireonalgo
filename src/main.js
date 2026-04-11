import { PeraWalletConnect } from '@perawallet/connect';

const peraWallet = new PeraWalletConnect();

const connectBtn = document.getElementById('connect-btn');
const walletInfo = document.getElementById('wallet-info');
const walletsContainer = document.getElementById('wallets-container');
const disconnectAllBtn = document.getElementById('disconnect-all-btn');

let connectedWallets = [];
let isExpanded = false;

function saveWallets() {
  localStorage.setItem('connectedWallets', JSON.stringify(connectedWallets.map(w => w.address)));
}

function loadSavedWallets() {
  try {
    const saved = localStorage.getItem('connectedWallets');
    return saved ? JSON.parse(saved) : [];
  } catch {
    return [];
  }
}

function toggleExpanded() {
  isExpanded = !isExpanded;
  if (isExpanded) {
    walletInfo.classList.add('wallet-expanded');
  } else {
    walletInfo.classList.remove('wallet-expanded');
  }
}

function shortAddress(addr) {
  return addr.slice(0, 6) + '...' + addr.slice(-4);
}

async function getNFDName(addr) {
  try {
    const res = await fetch(`https://api.nf.domains/nfd/lookup?address=${addr}&view=tiny`);
    if (!res.ok) return null;
    const data = await res.json();
    const nfd = data[addr];
    return nfd ? nfd.name : null;
  } catch {
    return null;
  }
}

function removeWallet(addr) {
  connectedWallets = connectedWallets.filter(w => w.address !== addr);
  saveWallets();
  renderWallets();
  if (connectedWallets.length === 0) {
    walletInfo.style.display = 'none';
    walletInfo.classList.remove('wallet-expanded');
    isExpanded = false;
    connectBtn.style.display = 'block';
    peraWallet.disconnect();
  }
}

function renderWallets() {
  walletsContainer.innerHTML = '';
  connectedWallets.forEach(wallet => {
    const pill = document.createElement('div');
    pill.className = 'wallet-pill';
    pill.innerHTML = `
      <span class="wallet-name">${wallet.name}</span>
      <span class="wallet-remove" data-addr="${wallet.address}">✕</span>
    `;
    pill.querySelector('.wallet-remove').addEventListener('click', (e) => {
      e.stopPropagation();
      removeWallet(wallet.address);
    });
    walletsContainer.appendChild(pill);
  });
}

async function addWallet(addr, shouldReload = false) {
  if (connectedWallets.find(w => w.address === addr)) return;
  const nfdName = await getNFDName(addr);
  connectedWallets.push({ address: addr, name: nfdName || shortAddress(addr) });
  saveWallets();
  renderWallets();
  connectBtn.style.display = 'none';
  walletInfo.style.display = 'flex';
  if (shouldReload) window.location.reload();
}

function onDisconnectAll() {
  connectedWallets = [];
  localStorage.removeItem('connectedWallets');
  walletsContainer.innerHTML = '';
  walletInfo.style.display = 'none';
  walletInfo.classList.remove('wallet-expanded');
  isExpanded = false;
  connectBtn.style.display = 'block';
  peraWallet.disconnect();
}

async function restoreWallets() {
  const saved = loadSavedWallets();
  if (saved.length > 0) {
    for (const addr of saved) {
      await addWallet(addr);
    }
  } else {
    peraWallet.reconnectSession().then(accounts => {
      if (accounts.length) accounts.forEach(addr => addWallet(addr));
    }).catch(() => {});
  }
}

restoreWallets();

walletsContainer.addEventListener('click', toggleExpanded);

connectBtn.addEventListener('click', () => {
  peraWallet.connect().then(accounts => {
    accounts.forEach(addr => addWallet(addr, true));
  }).catch(() => {});
});

document.getElementById('add-wallet-btn').addEventListener('click', () => {
  peraWallet.connect().then(accounts => {
    accounts.forEach(addr => addWallet(addr, true));
  }).catch(() => {});
});

disconnectAllBtn.addEventListener('click', onDisconnectAll);
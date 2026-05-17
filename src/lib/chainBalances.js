// Live on-chain balances for the multi-chain deposit wallets.
//
// One real keypair per network → a single address per chain, but
// each address holds several assets (native coin + stablecoins).
// All endpoints below are public + keyless + CORS-enabled so this
// runs straight from the admin browser. Every fetch is isolated
// (Promise.allSettled + per-call try/catch) so one dead API never
// blanks the whole screen — a failed asset just reports null.
//
// USD prices reuse fetchCoinPriceUsd (CoinLore, 5-min cache, same
// source as TON). Stablecoins are treated as $1.

import {
  TRON_DEPOSIT_ADDRESS,
  EVM_DEPOSIT_ADDRESS,
  BTC_DEPOSIT_ADDRESS,
  LTC_DEPOSIT_ADDRESS,
} from './addresses'
import { fetchCoinPriceUsd } from './currency'

// CORS-friendly, keyless RPC / explorer endpoints.
const ETH_RPC = 'https://ethereum.publicnode.com'
const BSC_RPC = 'https://bsc.publicnode.com'
const BTC_API = `https://blockstream.info/api/address/${BTC_DEPOSIT_ADDRESS}`
const LTC_API = `https://litecoinspace.org/api/address/${LTC_DEPOSIT_ADDRESS}`
const TRON_API = `https://api.trongrid.io/v1/accounts/${TRON_DEPOSIT_ADDRESS}`

// Token contracts (mainnet) + their decimals.
const T_USDT_ERC20 = { addr: '0xdAC17F958D2ee523a2206206994597C13D831ec7', dec: 6 }
const T_USDC_ERC20 = { addr: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', dec: 6 }
const T_USDT_BEP20 = { addr: '0x55d398326f99059fF775485246999027B3197955', dec: 18 }
const T_USDC_BEP20 = { addr: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', dec: 18 }
const T_USDT_TRC20 = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'

// CoinLore ticker ids (USD price) for the native coins.
const PRICE_ID = { btc: 90, eth: 80, bnb: 2710, trx: 2713, ltc: 1 }

function scaled(bigintLike, decimals) {
  try {
    const v = BigInt(bigintLike)
    const d = 10n ** BigInt(decimals)
    // keep 6 fractional digits of precision without float drift
    return Number((v * 1000000n) / d) / 1e6
  } catch {
    return 0
  }
}

async function rpc(url, method, params) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  if (!r.ok) throw new Error(`rpc ${r.status}`)
  const j = await r.json()
  if (j.error) throw new Error(j.error.message || 'rpc error')
  return j.result
}

async function evmNative(url) {
  const hex = await rpc(url, 'eth_getBalance', [EVM_DEPOSIT_ADDRESS, 'latest'])
  return scaled(hex, 18)
}

async function evmToken(url, contract, decimals) {
  // balanceOf(address) = 0x70a08231 + 32-byte left-padded address
  const data = '0x70a08231000000000000000000000000' +
    EVM_DEPOSIT_ADDRESS.slice(2).toLowerCase()
  const hex = await rpc(url, 'eth_call', [{ to: contract, data }, 'latest'])
  return scaled(hex, decimals)
}

async function btcLike(apiUrl) {
  const r = await fetch(apiUrl)
  if (!r.ok) throw new Error(`http ${r.status}`)
  const j = await r.json()
  const c = j.chain_stats || {}
  const sats = (c.funded_txo_sum || 0) - (c.spent_txo_sum || 0)
  return sats / 1e8
}

async function tronBalances() {
  const r = await fetch(TRON_API)
  if (!r.ok) throw new Error(`http ${r.status}`)
  const j = await r.json()
  const d = (j.data && j.data[0]) || {}
  const trx = (d.balance || 0) / 1e6
  let usdt = 0
  for (const entry of (d.trc20 || [])) {
    if (entry && entry[T_USDT_TRC20] != null) {
      usdt = Number(entry[T_USDT_TRC20]) / 1e6
    }
  }
  return { trx, usdt }
}

const safe = async (p) => {
  try { return await p } catch { return null }
}

/**
 * Fetch every extra-chain asset balance + its USD value.
 *
 * Returns:
 *   { assets: [{ id, symbol, name, network, address, amount,
 *                priceUsd, usd }],
 *     totalUsd, ok }   ── amount/usd are null when that asset's
 *                          API failed (shown as "—", excluded
 *                          from the total).
 */
export async function fetchChainBalances() {
  const [
    ethNat, ethUsdt, ethUsdc,
    bnbNat, bscUsdt, bscUsdc,
    btc, ltc, tron,
    pBtc, pEth, pBnb, pTrx, pLtc,
  ] = await Promise.all([
    safe(evmNative(ETH_RPC)),
    safe(evmToken(ETH_RPC, T_USDT_ERC20.addr, T_USDT_ERC20.dec)),
    safe(evmToken(ETH_RPC, T_USDC_ERC20.addr, T_USDC_ERC20.dec)),
    safe(evmNative(BSC_RPC)),
    safe(evmToken(BSC_RPC, T_USDT_BEP20.addr, T_USDT_BEP20.dec)),
    safe(evmToken(BSC_RPC, T_USDC_BEP20.addr, T_USDC_BEP20.dec)),
    safe(btcLike(BTC_API)),
    safe(btcLike(LTC_API)),
    safe(tronBalances()),
    safe(fetchCoinPriceUsd(PRICE_ID.btc)),
    safe(fetchCoinPriceUsd(PRICE_ID.eth)),
    safe(fetchCoinPriceUsd(PRICE_ID.bnb)),
    safe(fetchCoinPriceUsd(PRICE_ID.trx)),
    safe(fetchCoinPriceUsd(PRICE_ID.ltc)),
  ])

  const trx = tron ? tron.trx : null
  const trcUsdt = tron ? tron.usdt : null

  const mk = (id, symbol, name, network, address, amount, priceUsd) => {
    const amt = (typeof amount === 'number' && Number.isFinite(amount)) ? amount : null
    const px = (typeof priceUsd === 'number' && priceUsd > 0) ? priceUsd : null
    const usd = amt != null && px != null ? amt * px : (amt != null && px == null ? null : null)
    return { id, symbol, name, network, address, amount: amt, priceUsd: px, usd }
  }

  // Stablecoins are $1.
  const assets = [
    mk('trx',        'TRX',  'TRX',  'Tron',                 TRON_DEPOSIT_ADDRESS, trx,      pTrx),
    mk('usdt-trc20', 'USDT', 'USDT', 'Tron · TRC20',         TRON_DEPOSIT_ADDRESS, trcUsdt,  1),
    mk('eth',        'ETH',  'ETH',  'Ethereum',             EVM_DEPOSIT_ADDRESS,  ethNat,   pEth),
    mk('usdt-erc20', 'USDT', 'USDT', 'Ethereum · ERC20',     EVM_DEPOSIT_ADDRESS,  ethUsdt,  1),
    mk('usdc-erc20', 'USDC', 'USDC', 'Ethereum · ERC20',     EVM_DEPOSIT_ADDRESS,  ethUsdc,  1),
    mk('bnb',        'BNB',  'BNB',  'BNB Smart Chain',      EVM_DEPOSIT_ADDRESS,  bnbNat,   pBnb),
    mk('usdt-bep20', 'USDT', 'USDT', 'BNB Smart Chain · BEP20', EVM_DEPOSIT_ADDRESS, bscUsdt, 1),
    mk('usdc-bep20', 'USDC', 'USDC', 'BNB Smart Chain · BEP20', EVM_DEPOSIT_ADDRESS, bscUsdc, 1),
    mk('btc',        'BTC',  'BTC',  'Bitcoin',              BTC_DEPOSIT_ADDRESS,  btc,      pBtc),
    mk('ltc',        'LTC',  'LTC',  'Litecoin',             LTC_DEPOSIT_ADDRESS,  ltc,      pLtc),
  ]

  const totalUsd = assets.reduce((s, a) => s + (a.usd || 0), 0)
  const ok = assets.some(a => a.amount != null)
  return { assets, totalUsd, ok }
}

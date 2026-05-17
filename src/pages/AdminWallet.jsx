import { useState, useEffect, useCallback } from 'react'
import { haptic } from '../lib/telegram'
import { TON_ADDRESS, USDT_MASTER } from '../lib/addresses'
import { adminRequestWithdrawal, adminRequestUsdtWithdrawal, tronTreasury, treasuryWithdraw } from '../lib/supabase'
import { fetchChainBalances } from '../lib/chainBalances'
import useGameStore from '../store/useGameStore'
import smallTonSrc  from '../assets/crypto/small_ton.svg'
import smallUsdtSrc from '../assets/crypto/small_usdt.svg'
import smallUsdcSrc from '../assets/crypto/small_usdc.svg'
import smallTrxSrc  from '../assets/crypto/small_trx.svg'
import smallEthSrc  from '../assets/crypto/small_eth.svg'
import smallBtcSrc  from '../assets/crypto/small_btc.svg'
import smallBnbSrc  from '../assets/crypto/small_bnb.svg'
import smallLtcSrc  from '../assets/crypto/small_litecoin.svg'

// Per-asset icon for the multi-chain deposit cards. USDT/USDC
// reuse their disc across networks (the network is shown in the
// card subtitle), matching the deposit-sheet convention.
const CHAIN_ICON = {
  'trx':        smallTrxSrc,
  'usdt-trc20': smallUsdtSrc,
  'eth':        smallEthSrc,
  'usdt-erc20': smallUsdtSrc,
  'usdc-erc20': smallUsdcSrc,
  'bnb':        smallBnbSrc,
  'usdt-bep20': smallUsdtSrc,
  'usdc-bep20': smallUsdcSrc,
  'btc':        smallBtcSrc,
  'ltc':        smallLtcSrc,
}
const CHAIN_ACCENT = {
  'trx':        'linear-gradient(135deg, #EF3A3A 0%, #FF7A7A 100%)',
  'usdt-trc20': 'linear-gradient(135deg, #26A17B 0%, #4ECCA3 100%)',
  'eth':        'linear-gradient(135deg, #627EEA 0%, #A9B6F7 100%)',
  'usdt-erc20': 'linear-gradient(135deg, #26A17B 0%, #4ECCA3 100%)',
  'usdc-erc20': 'linear-gradient(135deg, #2775CA 0%, #6FA8E8 100%)',
  'bnb':        'linear-gradient(135deg, #F0B90B 0%, #F8D33A 100%)',
  'usdt-bep20': 'linear-gradient(135deg, #26A17B 0%, #4ECCA3 100%)',
  'usdc-bep20': 'linear-gradient(135deg, #2775CA 0%, #6FA8E8 100%)',
  'btc':        'linear-gradient(135deg, #F7931A 0%, #FFC46B 100%)',
  'ltc':        'linear-gradient(135deg, #345D9D 0%, #6E91C9 100%)',
}

// ── Chain icons — compact "small" variants (cleanest disc, no
//    extra stroke) that match the deposit-detail hero icons.
//    Rendered raw — no colored backing square. ──
function TonIcon() {
  return <img src={smallTonSrc} width={32} height={32} alt="" draggable="false" />
}

function UsdtIcon() {
  return <img src={smallUsdtSrc} width={32} height={32} alt="" draggable="false" />
}

// ── Blockchain API fetchers ──
async function fetchTonBalance(addr) {
  try {
    const r = await fetch(`https://toncenter.com/api/v2/getAddressBalance?address=${addr}`)
    if (!r.ok) return 0
    const d = await r.json()
    return d.ok ? Number(BigInt(d.result)) / 1e9 : 0
  } catch { return 0 }
}

// Our USDT jetton-wallet balance. TonCenter v3 returns the
// balance as a raw integer in micro-USDT (6 decimals). If the
// jetton-wallet hasn't been deployed yet (no USDT ever received)
// the array comes back empty → we return 0.
async function fetchUsdtBalance(ownerAddr) {
  try {
    const url = new URL('https://toncenter.com/api/v3/jetton/wallets')
    url.searchParams.set('owner_address', ownerAddr)
    url.searchParams.set('jetton_address', USDT_MASTER)
    url.searchParams.set('limit', '1')
    const r = await fetch(url)
    if (!r.ok) return 0
    const d = await r.json()
    const raw = d?.jetton_wallets?.[0]?.balance
    if (!raw) return 0
    return Number(BigInt(raw)) / 1e6
  } catch { return 0 }
}

let _priceCache = null
async function fetchPrices() {
  try {
    const r = await fetch('https://api.coinlore.net/api/ticker/?id=54683')
    if (!r.ok) throw new Error()
    const d = await r.json()
    const usd = parseFloat(d[0]?.price_usd) || 3
    let rubRate = 90
    try {
      const rr = await fetch('https://api.exchangerate-api.com/v4/latest/USD')
      if (rr.ok) {
        const rd = await rr.json()
        rubRate = rd.rates?.RUB ?? 90
      }
    } catch {}
    // USDT is pegged ~$1, so its USD price is 1 and its RUB
    // price is exactly the USD-RUB rate. Keeping both coins on
    // the same shape (`{ usd, rub }`) lets the rest of the UI
    // treat them identically.
    _priceCache = {
      ton:  { usd,    rub: usd * rubRate },
      usdt: { usd: 1, rub: rubRate },
    }
    return _priceCache
  } catch {
    if (_priceCache) return _priceCache
    return {
      ton:  { usd: 3, rub: 270 },
      usdt: { usd: 1, rub: 90  },
    }
  }
}

// ── Helpers ──
function truncAddr(a) { return !a || a.length < 16 ? a || '—' : `${a.slice(0, 8)}...${a.slice(-6)}` }
function copyText(t) { navigator.clipboard.writeText(t).catch(() => {}) }

function fmtFiat(v, cur) {
  if (cur === 'rub') {
    const rounded = Math.round(v)
    return rounded.toString().replace(/\B(?=(\d{3})+(?!\d))/g, '\u00A0') + ' \u20BD'
  }
  return '$' + v.toFixed(2)
}

const TON_ADDR_RE = /^(UQ|EQ|kQ|0:)[A-Za-z0-9_\-+/]{32,}/

export default function AdminWallet() {
  const user = useGameStore(s => s.user)
  const [tonBalance, setTonBalance] = useState(null)
  const [usdtBalance, setUsdtBalance] = useState(null)
  const [prices, setPrices] = useState(null)
  const [loading, setLoading] = useState(false)
  const [copied, setCopied] = useState(false)
  const [usdtCopied, setUsdtCopied] = useState(false)
  // Which extra-chain deposit-wallet card was just copied.
  const [copiedGroup, setCopiedGroup] = useState(null)
  // Live multi-chain balances { assets, totalUsd, ok } | null.
  const [chainData, setChainData] = useState(null)
  // TRON treasury energy (Stake 2.0).
  const [tron, setTron] = useState(null)        // info object | null
  const [tronLoading, setTronLoading] = useState(true)
  const [tronBusy, setTronBusy] = useState('')  // '', 'stake', 'unstake', 'withdraw'
  const [tronMsg, setTronMsg] = useState('')
  const [stakeAmt, setStakeAmt] = useState('')
  const [unstakeAmt, setUnstakeAmt] = useState('')
  // Multi-chain treasury withdrawal.
  const [wcChain, setWcChain] = useState('usdt-trc20')
  const [wcTo, setWcTo] = useState('')
  const [wcAmt, setWcAmt] = useState('')
  const [wcBusy, setWcBusy] = useState(false)
  const [wcMsg, setWcMsg] = useState('')
  const [lastRefresh, setLastRefresh] = useState(null)
  const [fiatCur, setFiatCur] = useState(localStorage.getItem('admin_fiat') || 'usd')

  // Withdraw form — single shared form whose fields are interpreted
  // per the active coin (`wdCoin`). `null` keeps the form hidden;
  // 'ton' / 'usdt' toggle the matching panel under either card.
  const [wdCoin, setWdCoin] = useState(null) // 'ton' | 'usdt' | null
  const [wdAddress, setWdAddress] = useState('')
  const [wdAmount, setWdAmount] = useState('')
  const [wdMemo, setWdMemo] = useState('')
  const [wdSending, setWdSending] = useState(false)
  const [wdError, setWdError] = useState('')
  const [wdSuccess, setWdSuccess] = useState(false)

  const fetchAll = useCallback(async () => {
    setLoading(true)
    try {
      const [tonBal, usdtBal, priceData, chain] = await Promise.all([
        fetchTonBalance(TON_ADDRESS),
        fetchUsdtBalance(TON_ADDRESS),
        fetchPrices(),
        fetchChainBalances(),
      ])
      setPrices(priceData)
      setTonBalance(tonBal)
      setUsdtBalance(usdtBal)
      setChainData(chain)
      setLastRefresh(new Date())
    } catch (err) {
      console.error('AdminWallet fetch error:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchAll() }, [fetchAll])

  // ── TRON treasury energy ──
  const loadTron = useCallback(async () => {
    if (!user?.id) return
    setTronLoading(true)
    const r = await tronTreasury('info', user.id)
    if (r && r.ok && r.info) setTron(r.info)
    else if (r && r.error) setTronMsg(r.error)
    setTronLoading(false)
  }, [user])

  useEffect(() => { loadTron() }, [loadTron])

  const doTron = useCallback(async (action, amount) => {
    if (!user?.id || tronBusy) return
    haptic('medium')
    setTronBusy(action)
    setTronMsg('')
    const r = await tronTreasury(action, user.id, amount)
    if (r && r.ok) {
      if (r.info) setTron(r.info)
      setTronMsg(`✓ ${action}${r.txid ? ' · ' + r.txid.slice(0, 12) + '…' : ''}`)
      setStakeAmt(''); setUnstakeAmt('')
    } else {
      setTronMsg('✗ ' + (r?.error || 'failed') + (r?.detail ? ' · ' + r.detail : ''))
    }
    setTronBusy('')
    setTimeout(loadTron, 4000)  // refresh once the tx settles
  }, [user, tronBusy, loadTron])

  const doWithdraw = useCallback(async () => {
    if (!user?.id || wcBusy) return
    if (!wcTo.trim() || !(Number(wcAmt) > 0)) { setWcMsg('Адрес и сумма?'); return }
    haptic('medium')
    setWcBusy(true); setWcMsg('')
    const r = await treasuryWithdraw(user.id, wcChain, wcTo.trim(), String(wcAmt).trim())
    if (r && r.ok) {
      setWcMsg(`✓ отправлено · ${r.txid ? r.txid.slice(0, 16) + '…' : ''}`)
      setWcTo(''); setWcAmt('')
    } else {
      setWcMsg('✗ ' + (r?.error || 'failed') +
        (r?.detail ? ' · ' + JSON.stringify(r.detail).slice(0, 120) : ''))
    }
    setWcBusy(false)
  }, [user, wcBusy, wcChain, wcTo, wcAmt])
  useEffect(() => {
    const iv = setInterval(fetchAll, 30_000)
    return () => clearInterval(iv)
  }, [fetchAll])

  function handleCopy() {
    haptic('light')
    copyText(TON_ADDRESS)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  function toggleFiat() {
    const next = fiatCur === 'usd' ? 'rub' : 'usd'
    setFiatCur(next)
    localStorage.setItem('admin_fiat', next)
    haptic('light')
  }

  async function handleWithdraw() {
    setWdError('')

    const amount = parseFloat(wdAmount)
    if (!amount || amount <= 0) {
      setWdError('Введите сумму')
      return
    }
    if (!TON_ADDR_RE.test(wdAddress.trim())) {
      setWdError('Невалидный TON адрес')
      return
    }
    // Coin-specific max checks:
    //   TON  → leave 0.05 TON cushion for gas (same as before).
    //   USDT → cap at USDT balance; TON gas (~0.06 TON per send)
    //          is paid from the hot TON balance, so we just warn
    //          the operator if the hot wallet looks too thin.
    if (wdCoin === 'ton') {
      if (tonBalance !== null && amount > tonBalance - 0.05) {
        setWdError(`Макс. ${(tonBalance - 0.05).toFixed(4)} TON (оставить на газ)`)
        return
      }
    } else if (wdCoin === 'usdt') {
      if (usdtBalance !== null && amount > usdtBalance) {
        setWdError(`Макс. ${usdtBalance.toFixed(2)} USDT`)
        return
      }
      if (tonBalance !== null && tonBalance < 0.08) {
        setWdError(`Мало TON на газ (нужно ≥ 0.08, есть ${tonBalance.toFixed(4)})`)
        return
      }
    }

    setWdSending(true)
    haptic('medium')

    try {
      const result = wdCoin === 'usdt'
        ? await adminRequestUsdtWithdrawal(user.id, wdAddress.trim(), amount, wdMemo.trim())
        : await adminRequestWithdrawal(user.id, wdAddress.trim(), amount, wdMemo.trim())
      if (result?.error) {
        setWdError(result.error)
        haptic('error')
      } else {
        setWdSuccess(true)
        haptic('success')
        setTimeout(() => {
          setWdSuccess(false)
          setWdCoin(null)
          setWdAddress('')
          setWdAmount('')
          setWdMemo('')
          fetchAll()
        }, 2000)
      }
    } catch (err) {
      setWdError(err.message || 'Ошибка')
      haptic('error')
    } finally {
      setWdSending(false)
    }
  }

  // Open / toggle the withdraw form for a specific coin. Resets the
  // amount field on coin switch so a TON amount doesn't leak into
  // the USDT field (and vice-versa).
  function toggleWithdraw(coin) {
    haptic('light')
    if (wdCoin === coin) {
      setWdCoin(null)
      return
    }
    setWdCoin(coin)
    setWdAmount('')
    setWdError('')
  }

  const fiatVal      = tonBalance  != null && prices ? tonBalance  * prices.ton[fiatCur]  : 0
  const usdtFiatVal  = usdtBalance != null && prices ? usdtBalance * prices.usdt[fiatCur] : 0
  // USD→selected-fiat factor (USDT is the $1 peg, so its `rub`
  // entry IS the live USD-RUB rate). Reused for every chain asset.
  const usdToFiat    = fiatCur === 'usd' ? 1 : (prices ? prices.usdt.rub : 1)
  const chainFiatVal = chainData ? chainData.totalUsd * usdToFiat : 0
  const totalFiatVal = fiatVal + usdtFiatVal + chainFiatVal
  const amountNum    = parseFloat(wdAmount) || 0
  // Fiat preview tracks whichever coin's form is currently open.
  const fiatPreview  = amountNum > 0 && prices && wdCoin
    ? amountNum * prices[wdCoin][fiatCur]
    : 0

  // Per-coin labels / MAX behavior. Centralized here so the JSX
  // stays a single shared shell instead of two near-identical
  // panels. The 0.05 TON cushion mirrors the user-facing TON
  // withdraw flow — without it MAX would empty the hot wallet
  // and the next batch couldn't pay its own gas.
  function renderWithdrawForm() {
    if (!wdCoin) return null
    const isUsdt = wdCoin === 'usdt'
    const coinLabel = isUsdt ? 'USDT' : 'TON'
    const stepValue = isUsdt ? '0.01' : '0.01'
    const onMax = () => {
      haptic('light')
      if (isUsdt && usdtBalance != null) {
        setWdAmount(usdtBalance.toFixed(2))
      } else if (!isUsdt && tonBalance != null) {
        const max = Math.max(0, tonBalance - 0.05)
        setWdAmount(max.toFixed(4))
      }
    }
    const canMax = isUsdt ? usdtBalance != null : tonBalance != null

    return (
      <div className="admin-wd-form">
        {wdSuccess ? (
          <div className="admin-wd-success">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10"/>
              <path d="M9 12l2 2 4-4"/>
            </svg>
            <span>Вывод отправлен в очередь</span>
          </div>
        ) : (
          <>
            <div className="admin-wd-field">
              <label className="admin-wd-label">TON адрес</label>
              <div className="admin-wd-input-wrap">
                <input
                  className="admin-wd-input"
                  placeholder="UQ... или EQ..."
                  value={wdAddress}
                  onChange={e => setWdAddress(e.target.value)}
                  spellCheck={false}
                  autoComplete="off"
                />
              </div>
            </div>

            <div className="admin-wd-field">
              <label className="admin-wd-label">Сумма {coinLabel}</label>
              <div className="admin-wd-amount-row">
                <input
                  className="admin-wd-input admin-wd-input--amount"
                  type="number"
                  step={stepValue}
                  min="0"
                  placeholder={isUsdt ? '0.00' : '0.0000'}
                  value={wdAmount}
                  onChange={e => setWdAmount(e.target.value)}
                  inputMode="decimal"
                />
                {canMax && (
                  <button className="admin-wd-max" onClick={onMax}>MAX</button>
                )}
              </div>
              {fiatPreview > 0 && (
                <span className="admin-wd-fiat-preview">
                  ~ {fmtFiat(fiatPreview, fiatCur)}
                </span>
              )}
            </div>

            <div className="admin-wd-field">
              <label className="admin-wd-label">Memo <span className="admin-wd-optional">(необязательно)</span></label>
              <input
                className="admin-wd-input"
                placeholder="Комментарий..."
                value={wdMemo}
                onChange={e => setWdMemo(e.target.value)}
              />
            </div>

            <div className="admin-wd-info">
              <span>Комиссия</span>
              <span className="admin-wd-no-fee">Без комиссии</span>
            </div>

            {wdError && (
              <div className="admin-wd-error">{wdError}</div>
            )}

            <button
              className="admin-wd-submit"
              onClick={handleWithdraw}
              disabled={wdSending || !wdAmount || !wdAddress}
            >
              {wdSending ? (
                <span className="admin-wd-spinner" />
              ) : (
                <>Отправить {amountNum > 0 ? `${amountNum} ${coinLabel}` : ''}</>
              )}
            </button>
          </>
        )}
      </div>
    )
  }

  function handleCopyUsdt() {
    haptic('light')
    copyText(TON_ADDRESS)
    setUsdtCopied(true)
    setTimeout(() => setUsdtCopied(false), 2000)
  }

  return (
    <div className="admin-wallet">
      {/* Top controls */}
      <div className="admin-wallet-controls">
        <button className="admin-fiat-toggle" onClick={toggleFiat}>
          {fiatCur === 'usd' ? '$ USD' : '\u20BD RUB'}
        </button>
        <button
          className={`admin-btn-refresh ${loading ? 'spinning' : ''}`}
          onClick={() => { haptic('medium'); fetchAll() }}
          disabled={loading}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M1 4v6h6M23 20v-6h-6"/>
            <path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10M23 14l-4.64 4.36A9 9 0 0 1 3.51 15"/>
          </svg>
        </button>
      </div>

      {lastRefresh && (
        <div className="admin-refresh-time">
          {'Updated '}
          {lastRefresh.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
          {' \u00B7 CoinLore'}
        </div>
      )}

      {/* Total balance card — sum of TON + USDT in selected fiat */}
      {tonBalance != null && usdtBalance != null && (
        <div className="admin-total-card">
          <span className="admin-total-label">Total Balance</span>
          <span className="admin-total-value">{fmtFiat(totalFiatVal, fiatCur)}</span>
          {totalFiatVal === 0 && (
            <span className="admin-total-empty">Wallet is empty</span>
          )}
        </div>
      )}

      {/* Skeleton while loading */}
      {tonBalance == null && loading && (
        <div className="admin-skeleton-list">
          <div className="admin-skeleton-card" />
        </div>
      )}

      {/* Wallet detail card */}
      {tonBalance != null && (
        <div className="admin-wallet-list">
          <div className="admin-wallet-card">
            <div className="admin-wallet-accent" style={{ background: 'linear-gradient(135deg, #0098EA 0%, #00D1FF 100%)' }} />

            <div className="admin-wallet-top">
              <div className="admin-wallet-icon-wrap" style={{ background: 'transparent', border: 'none', boxShadow: 'none' }}>
                <TonIcon />
              </div>
              <div className="admin-wallet-title">
                <span className="admin-wallet-name">TON</span>
                <span className="admin-wallet-fiat">{fmtFiat(fiatVal, fiatCur)}</span>
              </div>
            </div>

            <div className="admin-wallet-balance-row">
              <span className="admin-wallet-balance">{tonBalance.toFixed(4)}</span>
              <span className="admin-wallet-symbol">TON</span>
            </div>

            <div className="admin-wallet-addr-row">
              <code className="admin-wallet-addr">{truncAddr(TON_ADDRESS)}</code>
              <button className="admin-copy-btn" onClick={handleCopy}>
                {copied ? (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5"/></svg>
                ) : (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                )}
              </button>
            </div>

            {/* Withdraw button */}
            <button
              className="admin-wd-toggle"
              onClick={() => toggleWithdraw('ton')}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 5v14M19 12l-7 7-7-7"/>
              </svg>
              Вывести TON
            </button>

            {/* TON withdraw form — appears under the TON card so
              * the operator's eye doesn't have to jump to a panel
              * below an unrelated coin. */}
            {wdCoin === 'ton' && renderWithdrawForm()}
          </div>

          {/* USDT card — same layout as TON above, green Tether
            * theme. Withdraw routes through the same Edge
            * Function batch as TON (asset='usdt-ton'). */}
          {usdtBalance != null && (
            <div className="admin-wallet-card">
              <div className="admin-wallet-accent" style={{ background: 'linear-gradient(135deg, #26A17B 0%, #4ECCA3 100%)' }} />

              <div className="admin-wallet-top">
                <div className="admin-wallet-icon-wrap" style={{ background: 'transparent', border: 'none', boxShadow: 'none' }}>
                  <UsdtIcon />
                </div>
                <div className="admin-wallet-title">
                  <span className="admin-wallet-name">
                    USDT <span style={{ color: 'var(--text-muted)', fontWeight: 500, fontSize: '0.78em' }}>(Toncoin)</span>
                  </span>
                  <span className="admin-wallet-fiat">{fmtFiat(usdtFiatVal, fiatCur)}</span>
                </div>
              </div>

              <div className="admin-wallet-balance-row">
                <span className="admin-wallet-balance">{usdtBalance.toFixed(2)}</span>
                <span className="admin-wallet-symbol">USDT</span>
              </div>

              <div className="admin-wallet-addr-row">
                <code className="admin-wallet-addr">{truncAddr(TON_ADDRESS)}</code>
                <button className="admin-copy-btn" onClick={handleCopyUsdt}>
                  {usdtCopied ? (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5"/></svg>
                  ) : (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                  )}
                </button>
              </div>

              {/* USDT withdraw — same shape as TON. The Edge
                * Function pays TON gas (~0.06 TON / send) from
                * the hot wallet, so we soft-guard against an
                * empty TON balance inside handleWithdraw. */}
              <button
                className="admin-wd-toggle"
                onClick={() => toggleWithdraw('usdt')}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 5v14M19 12l-7 7-7-7"/>
                </svg>
                Вывести USDT
              </button>

              {wdCoin === 'usdt' && renderWithdrawForm()}
            </div>
          )}
        </div>
      )}

      {/* Multi-chain deposit wallets — one card PER ASSET (same
        * icon style as TON / USDT above). USDT(TRC20) and TRX are
        * split into their own cards even though they share the
        * Tron address (same for the EVM assets) — the address row
        * makes the shared wallet explicit. Balances are live
        * on-chain; "—" means that asset's API was unreachable. */}
      {chainData && chainData.assets && (
        <div className="admin-wallet-list">
          <div className="admin-wallet-section-title">Кошельки пополнения</div>
          {chainData.assets.map((a) => {
            const fiat = a.usd != null ? a.usd * usdToFiat : null
            return (
              <div key={a.id} className="admin-wallet-card">
                <div className="admin-wallet-accent" style={{ background: CHAIN_ACCENT[a.id] }} />
                <div className="admin-wallet-top">
                  <div className="admin-wallet-icon-wrap" style={{ background: 'transparent', border: 'none', boxShadow: 'none' }}>
                    <img src={CHAIN_ICON[a.id]} width={32} height={32} alt="" draggable="false" />
                  </div>
                  <div className="admin-wallet-title">
                    <span className="admin-wallet-name">
                      {a.name}{' '}
                      <span style={{ color: 'var(--text-muted)', fontWeight: 500, fontSize: '0.78em' }}>
                        {a.network}
                      </span>
                    </span>
                    <span className="admin-wallet-fiat">
                      {fiat != null ? fmtFiat(fiat, fiatCur) : '—'}
                    </span>
                  </div>
                </div>

                <div className="admin-wallet-balance-row">
                  <span className="admin-wallet-balance">
                    {a.amount != null
                      ? a.amount.toLocaleString('en-US', { maximumFractionDigits: a.amount < 1 ? 8 : 4 })
                      : '—'}
                  </span>
                  <span className="admin-wallet-symbol">{a.symbol}</span>
                </div>

                <div className="admin-wallet-addr-row">
                  <code className="admin-wallet-addr">{truncAddr(a.address)}</code>
                  <button
                    className="admin-copy-btn"
                    onClick={() => {
                      haptic('light')
                      copyText(a.address)
                      setCopiedGroup(a.id)
                      setTimeout(() => setCopiedGroup(c => (c === a.id ? null : c)), 1500)
                    }}
                  >
                    {copiedGroup === a.id ? (
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5"/></svg>
                    ) : (
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                    )}
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Price chip — TON & USDT current prices in the selected
        * fiat. USDT is pegged so its USD value is always 1.00,
        * but the chip is still useful for the live RUB-rate
        * cross-check. */}
      {prices && (
        <div className="admin-prices-bar">
          <div className="admin-price-chip">
            <span className="admin-price-dot" style={{ background: '#0098EA' }} />
            <span>TON</span>
            <span className="admin-price-val">{fmtFiat(prices.ton[fiatCur], fiatCur)}</span>
          </div>
          <div className="admin-price-chip">
            <span className="admin-price-dot" style={{ background: '#26A17B' }} />
            <span>USDT</span>
            <span className="admin-price-val">{fmtFiat(prices.usdt[fiatCur], fiatCur)}</span>
          </div>

          {/* New-chain coin prices — same live USD figure used to
            * value the wallets, shown in the selected fiat. */}
          {chainData && [
            { id: 'btc', label: 'BTC', dot: '#F7931A' },
            { id: 'eth', label: 'ETH', dot: '#627EEA' },
            { id: 'bnb', label: 'BNB', dot: '#F0B90B' },
            { id: 'trx', label: 'TRX', dot: '#EF3A3A' },
            { id: 'ltc', label: 'LTC', dot: '#345D9D' },
            { id: 'usdc-erc20', label: 'USDC', dot: '#2775CA' },
          ].map(({ id, label, dot }) => {
            const a = chainData.assets.find(x => x.id === id)
            if (!a || a.priceUsd == null) return null
            return (
              <div key={id} className="admin-price-chip">
                <span className="admin-price-dot" style={{ background: dot }} />
                <span>{label}</span>
                <span className="admin-price-val">
                  {fmtFiat(a.priceUsd * usdToFiat, fiatCur)}
                </span>
              </div>
            )
          })}
        </div>
      )}

      {/* ── TRON treasury energy (Stake 2.0) ──
        * Freeze TRX → Energy so sweeps delegate it and move
        * USDT-TRC20 for ≈0 TRX. Frozen TRX is collateral, not
        * spent: unstake (14-day unbond) → withdraw. */}
      <div className="admin-tron-stake">
        <div className="admin-wallet-section-title">
          TRON · Энергия (стейкинг)
        </div>

        {tronLoading && !tron && (
          <div className="admin-tron-row"><span>Загрузка…</span></div>
        )}

        {tron && (() => {
          const ePerTrx = tron.energyPerTrx || 0
          const usdtPerSweep = 65000          // ~energy a USDT transfer burns
          const sweepsCovered = usdtPerSweep > 0
            ? Math.floor(tron.energyAvail / usdtPerSweep) : 0
          const stakeNum = Number(String(stakeAmt).replace(',', '.'))
          const stakePreview = stakeNum > 0 && ePerTrx > 0
            ? Math.floor(stakeNum * ePerTrx) : 0
          const unstakeNum = Number(String(unstakeAmt).replace(',', '.'))
          const fmt = (n, d = 2) => Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: d })
          return (
            <>
              <div className="admin-tron-addr-row">
                <code className="admin-wallet-addr">{truncAddr(tron.address)}</code>
                <button
                  className="admin-copy-btn"
                  onClick={() => { haptic('light'); copyText(tron.address) }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                </button>
              </div>

              <div className="admin-tron-grid">
                <div className="admin-tron-stat">
                  <span className="admin-tron-k">Баланс TRX</span>
                  <span className="admin-tron-v">{fmt(tron.trx, 4)}</span>
                </div>
                <div className="admin-tron-stat">
                  <span className="admin-tron-k">Застейкано (Energy)</span>
                  <span className="admin-tron-v">{fmt(tron.stakedEnergyTrx, 2)} TRX</span>
                </div>
                <div className="admin-tron-stat">
                  <span className="admin-tron-k">Энергия всего</span>
                  <span className="admin-tron-v">{fmt(tron.energyTotal, 0)}</span>
                </div>
                <div className="admin-tron-stat">
                  <span className="admin-tron-k">Энергия свободна</span>
                  <span className="admin-tron-v">{fmt(tron.energyAvail, 0)}</span>
                </div>
                <div className="admin-tron-stat">
                  <span className="admin-tron-k">Делегировано</span>
                  <span className="admin-tron-v">{fmt(tron.delegatedOutTrx, 2)} TRX</span>
                </div>
                <div className="admin-tron-stat">
                  <span className="admin-tron-k">Курс</span>
                  <span className="admin-tron-v">{fmt(ePerTrx, 2)} E/TRX</span>
                </div>
              </div>

              <div className="admin-tron-note">
                Хватает на ~<b>{sweepsCovered}</b> USDT-свипов одновременно
                (≈{fmt(usdtPerSweep, 0)} энергии на перевод; энергия
                возвращается после каждого свипа).
              </div>

              {/* Stake */}
              <div className="admin-tron-action">
                <input
                  className="admin-tron-input"
                  type="number" inputMode="decimal" placeholder="TRX застейкать"
                  value={stakeAmt}
                  onChange={e => setStakeAmt(e.target.value)}
                />
                <button
                  className="admin-tron-btn"
                  disabled={!!tronBusy || !(stakeNum > 0) || stakeNum > tron.trx}
                  onClick={() => doTron('stake', stakeNum)}
                >
                  {tronBusy === 'stake' ? '…' : 'Стейк'}
                </button>
              </div>
              {stakePreview > 0 && (
                <div className="admin-tron-preview">≈ {fmt(stakePreview, 0)} энергии</div>
              )}

              {/* Unstake */}
              <div className="admin-tron-action">
                <input
                  className="admin-tron-input"
                  type="number" inputMode="decimal" placeholder="TRX анстейк"
                  value={unstakeAmt}
                  onChange={e => setUnstakeAmt(e.target.value)}
                />
                <button
                  className="admin-tron-btn admin-tron-btn--warn"
                  disabled={!!tronBusy || !(unstakeNum > 0) || unstakeNum > tron.stakedEnergyTrx}
                  onClick={() => doTron('unstake', unstakeNum)}
                >
                  {tronBusy === 'unstake' ? '…' : 'Анстейк'}
                </button>
              </div>
              <div className="admin-tron-preview admin-tron-preview--muted">
                Анстейк замораживается на 14 дней, потом «Забрать».
              </div>

              {/* Unfreezing queue */}
              {tron.unfreezing && tron.unfreezing.length > 0 && (
                <div className="admin-tron-unfreeze">
                  {tron.unfreezing.map((u, i) => (
                    <div key={i} className="admin-tron-unfreeze-row">
                      <span>{fmt(u.trx, 2)} TRX</span>
                      <span>{u.ready
                        ? 'готово к выводу'
                        : 'разблок ' + new Date(u.unlockAt).toLocaleDateString('ru-RU')}</span>
                    </div>
                  ))}
                </div>
              )}

              {tron.withdrawableTrx > 0 && (
                <button
                  className="admin-tron-btn admin-tron-btn--wide"
                  disabled={!!tronBusy}
                  onClick={() => doTron('withdraw')}
                >
                  {tronBusy === 'withdraw' ? '…' : `Забрать ${fmt(tron.withdrawableTrx, 2)} TRX`}
                </button>
              )}

              {tronMsg && <div className="admin-tron-msg">{tronMsg}</div>}
            </>
          )
        })()}
      </div>

      {/* ── Treasury withdrawal (multi-chain) ── */}
      <div className="admin-tron-stake">
        <div className="admin-wallet-section-title">Вывод из казны</div>
        <div className="admin-tron-note">
          Отправка с казны на любой адрес. Сумма — в монете
          (BTC/ETH/BNB/TRX/USDT/USDC/LTC). Комиссию платит казна.
        </div>
        <div className="admin-tron-action">
          <select
            className="admin-tron-input"
            value={wcChain}
            onChange={e => setWcChain(e.target.value)}
          >
            {[
              ['usdt-trc20', 'USDT · TRC20'],
              ['trx', 'TRX'],
              ['usdt-bep20', 'USDT · BEP20'],
              ['usdc-bep20', 'USDC · BEP20'],
              ['bnb', 'BNB'],
              ['usdt-erc20', 'USDT · ERC20'],
              ['usdc-erc20', 'USDC · ERC20'],
              ['eth', 'ETH'],
              ['btc', 'BTC'],
              ['ltc', 'LTC'],
            ].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </div>
        <div className="admin-tron-action">
          <input
            className="admin-tron-input"
            type="text" spellCheck="false" autoComplete="off"
            placeholder="Адрес получателя"
            value={wcTo}
            onChange={e => setWcTo(e.target.value)}
          />
        </div>
        <div className="admin-tron-action">
          <input
            className="admin-tron-input"
            type="number" inputMode="decimal" placeholder="Сумма (в монете)"
            value={wcAmt}
            onChange={e => setWcAmt(e.target.value)}
          />
          <button
            className="admin-tron-btn admin-tron-btn--warn"
            disabled={wcBusy || !wcTo.trim() || !(Number(wcAmt) > 0)}
            onClick={doWithdraw}
          >
            {wcBusy ? '…' : 'Вывести'}
          </button>
        </div>
        {wcMsg && <div className="admin-tron-msg">{wcMsg}</div>}
      </div>
    </div>
  )
}

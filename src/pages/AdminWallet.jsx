import { useState, useEffect, useCallback } from 'react'
import { haptic } from '../lib/telegram'
import { TON_ADDRESS, USDT_MASTER, DEPOSIT_WALLET_GROUPS } from '../lib/addresses'
import { adminRequestWithdrawal, adminRequestUsdtWithdrawal } from '../lib/supabase'
import useGameStore from '../store/useGameStore'
import smallTonSrc  from '../assets/crypto/small_ton.svg'
import smallUsdtSrc from '../assets/crypto/small_usdt.svg'

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
      const [tonBal, usdtBal, priceData] = await Promise.all([
        fetchTonBalance(TON_ADDRESS),
        fetchUsdtBalance(TON_ADDRESS),
        fetchPrices(),
      ])
      setPrices(priceData)
      setTonBalance(tonBal)
      setUsdtBalance(usdtBal)
      setLastRefresh(new Date())
    } catch (err) {
      console.error('AdminWallet fetch error:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchAll() }, [fetchAll])
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
  const totalFiatVal = fiatVal + usdtFiatVal
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

      {/* Multi-chain deposit wallets — the NEW cards. One real
        * keypair per network (see scripts/.wallets.secret.json),
        * so a single address serves the whole chain. No live
        * balance/withdraw yet (per-chain indexers are a separate
        * task) — this is the authoritative receiving-address
        * reference for the operator. */}
      <div className="admin-wallet-list">
        <div className="admin-wallet-section-title">Кошельки пополнения</div>
        {DEPOSIT_WALLET_GROUPS.map((g) => (
          <div key={g.id} className="admin-wallet-card">
            <div className="admin-wallet-accent" style={{ background: g.accent }} />
            <div className="admin-wallet-top">
              <div className="admin-wallet-title">
                <span className="admin-wallet-name">{g.name}</span>
                <span className="admin-wallet-fiat">{g.serves}</span>
              </div>
            </div>
            <div className="admin-wallet-addr-row">
              <code className="admin-wallet-addr">{truncAddr(g.address)}</code>
              <button
                className="admin-copy-btn"
                onClick={() => {
                  haptic('light')
                  copyText(g.address)
                  setCopiedGroup(g.id)
                  setTimeout(() => setCopiedGroup(c => (c === g.id ? null : c)), 1500)
                }}
              >
                {copiedGroup === g.id ? (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5"/></svg>
                ) : (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                )}
              </button>
            </div>
          </div>
        ))}
      </div>

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
        </div>
      )}
    </div>
  )
}

import { useEffect, useState, useRef } from 'react'
import { useTonConnectUI, useTonWallet, useTonAddress } from '@tonconnect/ui-react'
// Static imports of @ton/core — building cells (text-comment for
// TON deposits, jetton-transfer body for USDT) is on the critical
// path of the Continue button, so a one-time bundle cost (~30 KB
// gzipped) is cheaper than the inevitable first-tap latency of a
// dynamic import + the occasional dev-mode chunk-fetch failure.
import { beginCell as tonBeginCell, Address as TonAddress } from '@ton/core'
import useGameStore from '../store/useGameStore'
import { haptic, requestStarsPayment, getTelegramUser } from '../lib/telegram'
import { createStarsInvoice, processDeposit, getUserBalance, supabase } from '../lib/supabase'
import { formatCurrency, convertFromRub, fetchTonPrice } from '../lib/currency'
import { translations } from '../lib/i18n'
import { TON_ADDRESS, USDT_ADDRESS, USDT_MASTER } from '../lib/addresses'
import tgStarSrc      from '../assets/star/tgstar.png'
import tonIconSrc     from '../assets/crypto/ton.svg'
import usdtIconSrc    from '../assets/crypto/usdt.svg'
import smallTonSrc    from '../assets/crypto/small_ton.svg'
import smallUsdtSrc   from '../assets/crypto/small_usdt.svg'
import tonBadgeSrc    from '../assets/crypto/small_ton_for_usdt.svg'
import './DepositSheet.css'

const PRESETS = [100, 500, 1000]
const MIN_STARS = 100

// TON / USDT coin icons are user-supplied SVG assets in
// src/assets/crypto/. Rendered as <img> so the SVG is treated
// as a static image (no inline DOM bloat, lighter render).
function TonIcon({ size = 22 }) {
  return <img src={tonIconSrc} width={size} height={size} alt="" draggable="false" />
}

function UsdtIcon({ size = 22 }) {
  return <img src={usdtIconSrc} width={size} height={size} alt="" draggable="false" />
}

// Compact "small TON" used as the detail-screen hero icon.
// Same TON glyph but without the heavy outer stroke that the
// USDT-corner-badge version carries — better for inline use
// where the icon isn't trying to pop against a green disc.
function SmallTonIcon({ size = 22 }) {
  return <img src={smallTonSrc} width={size} height={size} alt="" draggable="false" />
}

// Compact USDT — sister of SmallTonIcon. Clean Tether disc
// without any stacked network badge, used for the USDT detail
// hero so it visually matches the TON detail hero's bare-icon
// style.
function SmallUsdtIcon({ size = 22 }) {
  return <img src={smallUsdtSrc} width={size} height={size} alt="" draggable="false" />
}

// Small TON badge overlay — sits in the bottom-right corner of
// the USDT icon to signal "USDT on the TON network" (matches
// the convention used across TON wallets and exchanges).
function UsdtTonIcon({ size = 22 }) {
  const badgeSize = Math.round(size * 0.42)
  return (
    <span className="deposit-coin-icon-stack" style={{ width: size, height: size }}>
      <img src={usdtIconSrc} width={size} height={size} alt="" draggable="false" />
      <img
        className="deposit-coin-icon-badge"
        src={smallTonSrc}
        width={badgeSize}
        height={badgeSize}
        alt=""
        draggable="false"
      />
    </span>
  )
}

function TgStarIcon({ size = 22, className = '' }) {
  return (
    <img
      className={`tg-star-icon ${className}`.trim()}
      src={tgStarSrc}
      alt=""
      aria-hidden="true"
      width={size}
      height={size}
      draggable="false"
      style={{ width: size, height: size }}
    />
  )
}

/** Raw numeric currency amount for DB (e.g. 100.10) — 1 Star = 1 RUB */
function toCurrencyRaw(stars, curCode, rates) {
  const amount = convertFromRub(stars, curCode, rates)
  return Math.round(amount * 100) / 100
}

function BackButton({ label, onClick }) {
  return (
    <button className="deposit-back" onClick={onClick}>
      <div className="deposit-back-icon">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round">
          <path d="M15 18l-6-6 6-6" />
        </svg>
      </div>
      {label}
    </button>
  )
}

function SuccessCheckmark() {
  return (
    <div className="deposit-success-circle">
      <svg className="deposit-success-check" width="48" height="48" viewBox="0 0 48 48" fill="none">
        <path d="M12 25L20 33L36 15" stroke="#22c55e" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  )
}

/** Poll balance from DB with retries (webhook may need a moment) */
async function pollBalance(userId, prevBalance, maxRetries = 4) {
  for (let i = 0; i < maxRetries; i++) {
    await new Promise(r => setTimeout(r, 600 + i * 400))
    try {
      const bal = await getUserBalance(userId)
      if (bal > prevBalance) return bal
    } catch { /* retry */ }
  }
  return null // webhook didn't process in time
}

export default function DepositSheet() {
  const { depositOpen, setDepositOpen, lang, currency, rates, user, balance, setBalance, setBalanceBounce, appSettings } = useGameStore()
  const t = translations[lang]
  const starsEnabled = appSettings.stars_deposits !== false
  const cryptoEnabled = appSettings.crypto_deposits !== false

  const [view, setView] = useState('main')
  const [selected, setSelected] = useState(100)
  const [custom, setCustom] = useState('')
  const [loading, setLoading] = useState(false)
  const [status, setStatus] = useState('idle')
  const [copiedField, setCopiedField] = useState(null) // 'address' | 'memo'
  const [tonPrice, setTonPrice] = useState(null)       // USD per 1 TON
  const successAmountRef = useRef(0)
  const invoiceTxRef = useRef(null) // shared tx_id between webhook & client

  // ── TON Connect ──
  // useTonConnectUI gives us the imperative API (open modal, send tx).
  // useTonWallet returns null until a wallet is connected; useTonAddress
  // returns the user-friendly UQ... address once connected. We treat
  // `tonWallet` as the source of truth for "is wallet connected" so the
  // CTA at the bottom of the TON deposit view swaps between
  // "Connect TON Wallet" and "Top Up via TON Wallet" automatically
  // (including across sessions — TON Connect SDK persists state).
  const [tonConnectUI] = useTonConnectUI()
  const tonWallet = useTonWallet()
  const tonAddrFriendly = useTonAddress(true)
  const isTonWalletConnected = !!tonWallet
  const [tonWalletBalance, setTonWalletBalance] = useState(null) // TON, native units
  const [tonWalletAmount, setTonWalletAmount] = useState('')     // input for amount in TON
  const [tonWalletSending, setTonWalletSending] = useState(false)
  const [tonWalletError, setTonWalletError] = useState('')
  // Minimum TON deposit — derived from MIN_RUB (200 ₽). Will be
  // recomputed below once tonPrice resolves.
  const MIN_TON_FALLBACK = 0.5

  // ── USDT-via-TonConnect state ──
  // Mirrors the TON path: balance read, amount input, send.
  // Extra `usdtJettonWallet` is the user's TIP-3 jetton-wallet
  // address derived from their connected main wallet — that's
  // the contract `sendTransaction` actually targets (not the
  // master, not their main address).
  const [usdtJettonWallet, setUsdtJettonWallet] = useState(null)
  const [usdtWalletBalance, setUsdtWalletBalance] = useState(null)
  const [usdtWalletAmount, setUsdtWalletAmount] = useState('')
  const [usdtWalletSending, setUsdtWalletSending] = useState(false)
  const [usdtWalletError, setUsdtWalletError] = useState('')

  // Snapshot of the user's balance at the moment we go into
  // 'confirming' — used to compute the credited delta when the
  // realtime channel on `transactions` finally fires and the
  // store's `balance` bumps up. Null means we're not currently
  // waiting on an on-chain confirmation.
  const [confirmingPrevBalance, setConfirmingPrevBalance] = useState(null)
  // ~$2.50 — picked so even at very low TON prices the user
  // still has a sensible floor if the live rate fails to load.
  const MIN_USDT_FALLBACK = 2.5

  // Lazy-fetch the TON price when the user lands on a coin
  // detail view. Cached for 5 min by the currency lib, so
  // re-opening the sheet during that window is a no-op.
  useEffect(() => {
    if (view === 'ton' || view === 'usdt') {
      let cancelled = false
      fetchTonPrice().then(p => {
        if (!cancelled && p > 0) setTonPrice(p)
      })
      return () => { cancelled = true }
    }
  }, [view])

  const activeAmount = custom !== '' ? Number(custom) : selected
  const isCustomValid = custom === '' || Number(custom) >= MIN_STARS
  const canBuy = activeAmount >= MIN_STARS && isCustomValid && !loading

  const close = () => {
    haptic('light')
    setDepositOpen(false)
  }

  const goBack = () => {
    haptic('light')
    if (status !== 'idle') {
      setStatus('idle')
      setView('stars')
    } else if (view === 'ton-wallet') {
      // The TON-Connect deposit view is one level deeper than the
      // TON detail screen. Back goes to the TON detail (which
      // still hosts the "Top Up via TON Wallet" CTA so re-entering
      // is one tap away).
      setView('ton')
      setTonWalletAmount('')
      setTonWalletError('')
    } else if (view === 'usdt-wallet') {
      // Symmetric to ton-wallet → back to the USDT detail screen.
      setView('usdt')
      setUsdtWalletAmount('')
      setUsdtWalletError('')
    } else {
      // Coin detail (ton / usdt) → back to main (which now has
      // the TON + USDT cards inline under "Криптовалюта").
      setView('main')
      setCopiedField(null)
    }
  }

  // Reset on close
  useEffect(() => {
    if (!depositOpen) {
      setTimeout(() => {
        setView('main')
        setCustom('')
        setSelected(100)
        setLoading(false)
        setStatus('idle')
        setCopiedField(null)
        invoiceTxRef.current = null
        setTonWalletAmount('')
        setTonWalletError('')
        setTonWalletSending(false)
        setUsdtWalletAmount('')
        setUsdtWalletError('')
        setUsdtWalletSending(false)
        setConfirmingPrevBalance(null)
      }, 300)
    }
  }, [depositOpen])

  // Fetch the connected wallet's TON balance whenever the user
  // lands on the TON-Connect deposit view (and any time the
  // connection changes). Re-uses TonCenter's public RPC — same
  // endpoint AdminWallet uses for the hot-wallet balance read.
  useEffect(() => {
    if (view !== 'ton-wallet' || !tonAddrFriendly) {
      return
    }
    let cancelled = false
    const fetchWalletBalance = async () => {
      try {
        const r = await fetch(`https://toncenter.com/api/v2/getAddressBalance?address=${tonAddrFriendly}`)
        if (!r.ok) return
        const d = await r.json()
        if (!cancelled && d?.ok) {
          setTonWalletBalance(Number(BigInt(d.result)) / 1e9)
        }
      } catch { /* ignore — UI falls back to no-balance state */ }
    }
    fetchWalletBalance()
    return () => { cancelled = true }
  }, [view, tonAddrFriendly])

  // Resolve the user's USDT jetton-wallet + balance when they
  // land on the USDT-Connect deposit view. TonCenter v3 returns
  // both the wallet address and the raw micro-USDT balance in a
  // single call — perfect because we need both to build the
  // jetton-transfer body AND to render the balance card.
  //
  // The wallet address comes back in raw `0:hex` form which the
  // TON Connect SDK rejects with "Wrong 'address' format" —
  // run it through TonAddress.parse(...).toString() to
  // canonicalize to a bounceable EQ-prefixed address that both
  // the SDK and every wallet accept.
  useEffect(() => {
    if (view !== 'usdt-wallet' || !tonAddrFriendly) return
    let cancelled = false
    const fetchUsdtWalletInfo = async () => {
      try {
        const url = new URL('https://toncenter.com/api/v3/jetton/wallets')
        url.searchParams.set('owner_address', tonAddrFriendly)
        url.searchParams.set('jetton_address', USDT_MASTER)
        url.searchParams.set('limit', '1')
        const r = await fetch(url)
        if (!r.ok) return
        const d = await r.json()
        const w = d?.jetton_wallets?.[0]
        if (cancelled) return
        if (w?.address) {
          try {
            const canonical = TonAddress.parse(w.address).toString({ bounceable: true })
            setUsdtJettonWallet(canonical)
          } catch {
            setUsdtJettonWallet(w.address) // fallback to raw — surfaces a clearer SDK error than silence
          }
        }
        if (w?.balance) setUsdtWalletBalance(Number(BigInt(w.balance)) / 1e6)
        else setUsdtWalletBalance(0)
      } catch { /* ignore */ }
    }
    fetchUsdtWalletInfo()
    return () => { cancelled = true }
  }, [view, tonAddrFriendly])

  // Telegram BackButton
  useEffect(() => {
    const tg = window.Telegram?.WebApp
    if (!tg) return
    if (depositOpen) {
      tg.BackButton.show()
      const handler = () => {
        if (view !== 'main') goBack()
        else close()
      }
      tg.BackButton.onClick(handler)
      return () => { tg.BackButton.offClick(handler) }
    } else {
      tg.BackButton.hide()
    }
  }, [depositOpen, view])

  // Auto-close after success
  useEffect(() => {
    if (status === 'success') {
      const timer = setTimeout(() => {
        setDepositOpen(false)
        setTimeout(() => {
          setBalanceBounce(true)
          setTimeout(() => setBalanceBounce(false), 700)
        }, 350)
      }, 1500)
      return () => clearTimeout(timer)
    }
  }, [status])

  // confirming → success transition. The store's `balance` is
  // updated by App.jsx's Realtime listener on the `transactions`
  // table the moment our indexer credits the deposit. We compare
  // against the snapshot taken when sendTransaction resolved and,
  // as soon as the balance bumps, flip to success with the actual
  // credited delta in `successAmountRef` so the user sees a real
  // "+N RUB" line instead of "+0".
  useEffect(() => {
    if (status !== 'confirming' || confirmingPrevBalance == null) return
    if (balance > confirmingPrevBalance) {
      successAmountRef.current = balance - confirmingPrevBalance
      setStatus('success')
      setConfirmingPrevBalance(null)
    }
  }, [status, balance, confirmingPrevBalance])

  // Safety net — TON-Center / Realtime can hiccup. If we've been
  // sitting in 'confirming' for 90 s with no balance bump, fall
  // through to success with a 0 amount so the sheet doesn't trap
  // the user forever. Reset is handled by the close-reset effect.
  useEffect(() => {
    if (status !== 'confirming') return
    const timer = setTimeout(() => {
      successAmountRef.current = 0
      setStatus('success')
      setConfirmingPrevBalance(null)
    }, 90_000)
    return () => clearTimeout(timer)
  }, [status])

  function handlePreset(amount) {
    haptic('light')
    setSelected(amount)
    setCustom('')
  }

  function handleCustomChange(e) {
    const val = e.target.value.replace(/\D/g, '')
    setCustom(val)
    if (val !== '') setSelected(null)
  }

  async function handleBuy() {
    if (!canBuy) return
    haptic('medium')
    setLoading(true)
    successAmountRef.current = activeAmount

    const userId = user?.id
    const prevBalance = useGameStore.getState().balance

    // ── Dev mode ──
    if (!getTelegramUser()) {
      await new Promise(r => setTimeout(r, 500))
      setBalance(prevBalance + activeAmount)
      setLoading(false)
      setStatus('success')
      haptic('heavy')
      return
    }

    // ── Real Telegram: create invoice → open → process ──
    try {
      const curAmt = toCurrencyRaw(activeAmount, currency.code, rates)
      const invoice = await createStarsInvoice(userId, activeAmount, curAmt, currency.code)
      if (!invoice?.url || !invoice?.tx_id) {
        setLoading(false)
        setStatus('error')
        haptic('heavy')
        return
      }

      invoiceTxRef.current = invoice.tx_id

      requestStarsPayment({
        payload: invoice.url,
        onSuccess: async () => {
          const polled = await pollBalance(userId, prevBalance)

          if (polled != null) {
            setBalance(polled)
          } else {
            try {
              const curAmt = toCurrencyRaw(activeAmount, currency.code, rates)
              const result = await processDeposit(userId, activeAmount, invoiceTxRef.current, curAmt, currency.code)
              if (result?.new_balance != null) {
                setBalance(result.new_balance)
              } else {
                const fresh = await getUserBalance(userId)
                setBalance(fresh ?? prevBalance)
              }
            } catch {
              try {
                const fresh = await getUserBalance(userId)
                setBalance(fresh ?? prevBalance)
              } catch { /* keep prev balance, Realtime will catch up */ }
            }
          }

          setLoading(false)
          setStatus('success')
          haptic('heavy')
        },
        onFail: (failStatus) => {
          setLoading(false)
          if (failStatus !== 'cancelled') {
            setStatus('error')
          }
          haptic('medium')
        },
      })
    } catch (err) {
      console.error('Payment error:', err)
      setLoading(false)
      setStatus('error')
      haptic('heavy')
    }
  }

  function handleCopy(text, field) {
    navigator.clipboard.writeText(text).then(() => {
      haptic('light')
      setCopiedField(field)
      setTimeout(() => setCopiedField(null), 2000)
    })
  }

  // ── TON Connect handlers ──
  // Opens the standard TON-Connect modal (Wallet in Telegram +
  // Tonkeeper / MyTonWallet / Tonhub / etc.). The SDK manages
  // persistence + reconnection on its own; we just react to
  // `tonWallet` via the hook.
  async function handleConnectTonWallet() {
    haptic('medium')
    try {
      await tonConnectUI.openModal()
    } catch (err) {
      console.error('TON Connect openModal error:', err)
    }
  }

  async function handleDisconnectTonWallet() {
    haptic('light')
    try {
      await tonConnectUI.disconnect()
    } catch (err) {
      console.error('TON Connect disconnect error:', err)
    }
    // Clear local form state but keep the user on the relevant
    // coin detail (TON / USDT) so the CTA gracefully reverts to
    // "Connect TON Wallet" without any view jump.
    const goTo = view === 'usdt-wallet' ? 'usdt' : 'ton'
    setView(goTo)
    setTonWalletAmount('')
    setTonWalletError('')
    setTonWalletBalance(null)
    setUsdtWalletAmount('')
    setUsdtWalletError('')
    setUsdtWalletBalance(null)
    setUsdtJettonWallet(null)
  }

  // Build a comment cell payload (op = 0, then UTF-8 bytes of the
  // memo) as a base64 BOC. The same shape `process-withdrawals`
  // attaches to outgoing TON transfers — our crypto indexer reads
  // the memo to attribute the deposit back to the right user_id.
  // Helper: convert a Uint8Array / Buffer-like to base64 via
  // window.btoa. Standalone so the comment + jetton-transfer
  // body builders share the exact same encoding path.
  function bocToBase64(boc) {
    const view = boc instanceof Uint8Array ? boc : new Uint8Array(boc)
    let bin = ''
    for (let i = 0; i < view.length; i++) bin += String.fromCharCode(view[i])
    return window.btoa(bin)
  }

  function buildCommentPayloadBase64(text) {
    // A standard text-comment body is:
    //   storeUint(0, 32)  → op=0 (text comment)
    //   then UTF-8 bytes of the comment, one byte per snake cell.
    const bytes = new TextEncoder().encode(text)
    const b = tonBeginCell().storeUint(0, 32)
    for (const x of bytes) b.storeUint(x, 8)
    return bocToBase64(b.endCell().toBoc())
  }

  async function handleTonWalletSend() {
    setTonWalletError('')
    const amount = Number(tonWalletAmount.replace(',', '.'))
    if (!Number.isFinite(amount) || amount <= 0) {
      setTonWalletError(t.depositTonWalletMin.replace('{min}', minTon ? minTon.toFixed(3) : MIN_TON_FALLBACK.toFixed(2)))
      return
    }
    const effectiveMin = (minTon && minTon > 0) ? minTon : MIN_TON_FALLBACK
    if (amount < effectiveMin) {
      setTonWalletError(t.depositTonWalletMin.replace('{min}', effectiveMin.toFixed(3)))
      return
    }
    if (tonWalletBalance != null && amount > tonWalletBalance) {
      setTonWalletError(t.depositTonWalletInsuff)
      return
    }

    setTonWalletSending(true)
    haptic('medium')
    try {
      // Memo must be the bare numeric telegram_id — the crypto
      // indexer (check-crypto-deposits) parseInts the comment as
      // a telegram_id and only accepts strings that round-trip
      // back to the same integer. Anything else (e.g. "uid:42")
      // is silently dropped → deposit goes unattributed.
      const memo = String(user?.telegram_id ?? '')
      if (!memo || !/^\d+$/.test(memo)) {
        setTonWalletError(t.depositTonWalletFailed)
        setTonWalletSending(false)
        return
      }
      const payload = buildCommentPayloadBase64(memo)
      const nanoAmount = BigInt(Math.round(amount * 1e9)).toString()

      await tonConnectUI.sendTransaction({
        validUntil: Math.floor(Date.now() / 1000) + 600, // 10 min
        messages: [{
          address: TON_ADDRESS,
          amount:  nanoAmount,
          payload,
        }],
      })

      // sendTransaction resolves the moment the user confirms in
      // their wallet AND the wallet broadcasts the signed message
      // — but the tx is not on-chain yet (~5-15 s) and we MUST
      // NOT credit balance optimistically (a malicious wallet
      // could ack without broadcasting). Instead, kick the
      // indexer Edge Function right now: it polls TonCenter, sees
      // the tx as soon as it's in a block, calls process_deposit,
      // and the global Realtime channel on `transactions` updates
      // the user's balance + bounces the header pill — usually
      // within 10-15 s instead of waiting up to a full pg_cron tick.
      supabase.functions.invoke('check-crypto-deposits').catch(() => {})

      // Show a spinner until the realtime channel on
      // `transactions` actually fires (App.jsx updates the store
      // balance). The effect below watches the store and flips
      // us to 'success' with the real credited delta as soon as
      // the balance bumps. Snapshotting the previous balance
      // *before* setting status guarantees we never miss a fast
      // confirmation.
      setConfirmingPrevBalance(useGameStore.getState().balance)
      setStatus('confirming')
      haptic('heavy')
    } catch (err) {
      console.error('sendTransaction error:', err)
      const rawMsg = String(err?.message || err || '').trim()
      const userCancelled = /reject|cancel|user/i.test(rawMsg)
      // Append the raw wallet/SDK error in production too — it's
      // the only way the operator can tell whether the failure
      // was a manifest/network/address issue without console
      // access. Truncate so the UI doesn't wrap forever.
      const tail = rawMsg ? ' — ' + rawMsg.slice(0, 200) : ''
      setTonWalletError(userCancelled
        ? t.depositTonWalletCancelled
        : t.depositTonWalletFailed + tail)
      haptic('medium')
    } finally {
      setTonWalletSending(false)
    }
  }

  // Build a TIP-3 jetton-transfer body (op 0x0f8a7ea5) and return
  // a base64 BOC for use as TON Connect `payload`. Mirrors the
  // shape the Edge Function builds server-side for outgoing
  // withdrawals — same op code, same field order, just routed
  // FROM the user's jetton-wallet TO our hot wallet instead of
  // the other way around.
  //
  //   amountMicroUsdt    — USDT to send, integer in micro-USDT (6 dec).
  //   destination        — recipient's MAIN TON address (our hot wallet).
  //   responseDestination — refund recipient (user's main wallet).
  //   forwardTonAmount   — TON tipped along with the jetton (also
  //                        funds the recipient-side notification).
  //   comment            — text payload that ends up in
  //                        `forward_payload`; check-usdt-deposits
  //                        reads it as the user's telegram_id.
  function buildJettonTransferPayloadBase64({
    amountMicroUsdt, destination, responseDestination, forwardTonNano, comment,
  }) {
    const b = tonBeginCell()
      .storeUint(0x0f8a7ea5, 32)
      .storeUint(0, 64)              // query_id — TonConnect handles dedup
      .storeCoins(amountMicroUsdt)
      .storeAddress(TonAddress.parse(destination))
      .storeAddress(TonAddress.parse(responseDestination))
      .storeBit(false)               // no custom_payload
      .storeCoins(forwardTonNano)

    if (comment) {
      const bytes = new TextEncoder().encode(comment)
      const c = tonBeginCell().storeUint(0, 32)
      for (const x of bytes) c.storeUint(x, 8)
      b.storeBit(true)
      b.storeRef(c.endCell())
    } else {
      b.storeBit(false)
    }

    return bocToBase64(b.endCell().toBoc())
  }

  async function handleUsdtWalletSend() {
    setUsdtWalletError('')
    const amount = Number(usdtWalletAmount.replace(',', '.'))
    if (!Number.isFinite(amount) || amount <= 0) {
      setUsdtWalletError(t.depositUsdtWalletMin.replace('{min}', minUsdt ? minUsdt.toFixed(2) : MIN_USDT_FALLBACK.toFixed(2)))
      return
    }
    const effectiveMin = (minUsdt && minUsdt > 0) ? minUsdt : MIN_USDT_FALLBACK
    if (amount < effectiveMin) {
      setUsdtWalletError(t.depositUsdtWalletMin.replace('{min}', effectiveMin.toFixed(2)))
      return
    }
    if (usdtWalletBalance != null && amount > usdtWalletBalance) {
      setUsdtWalletError(t.depositTonWalletInsuff)
      return
    }
    if (!usdtJettonWallet) {
      // The wallet has no USDT jetton-wallet deployed — we can't
      // build a jetton-transfer because there's no contract to
      // send it to. The user must receive some USDT first to
      // auto-deploy the jetton-wallet sub-contract.
      setUsdtWalletError(t.depositTonWalletNoUsdt)
      return
    }

    setUsdtWalletSending(true)
    haptic('medium')
    try {
      const memo = String(user?.telegram_id ?? '')
      if (!memo || !/^\d+$/.test(memo)) {
        setUsdtWalletError(t.depositTonWalletFailed)
        setUsdtWalletSending(false)
        return
      }

      // micro-USDT (6 decimals). Floor avoids overpaying due to
      // float imprecision (e.g. 10.000001 would otherwise round up).
      const microUsdt = BigInt(Math.floor(amount * 1e6))
      // 0.01 TON forwarded to the recipient with the jetton — acts
      // as the notification gas + a tiny tip. Matches the value
      // process-withdrawals uses for the reverse direction.
      const forwardTonNano = BigInt(Math.round(0.01 * 1e9))

      const payload = buildJettonTransferPayloadBase64({
        amountMicroUsdt:     microUsdt,
        destination:         TON_ADDRESS,           // our hot wallet (final USDT recipient)
        responseDestination: tonAddrFriendly,       // refund excess TON to the user
        forwardTonNano,
        comment:             memo,
      })

      // 0.05 TON attached to cover gas for the user's
      // jetton-wallet hop + the forward to our jetton-wallet.
      const valueNano = BigInt(Math.round(0.05 * 1e9)).toString()

      await tonConnectUI.sendTransaction({
        validUntil: Math.floor(Date.now() / 1000) + 600,
        messages: [{
          address: usdtJettonWallet,   // user's USDT jetton-wallet
          amount:  valueNano,
          payload,
        }],
      })

      // Same logic as the TON path — ping the USDT indexer right
      // away so the on-chain tx is picked up within ~10-15 s
      // instead of after the next pg_cron tick. The indexer is
      // idempotent (tx_hash dedup), so re-pinging it has no
      // downside.
      supabase.functions.invoke('check-usdt-deposits').catch(() => {})

      // Spinner-until-confirmed (see TON branch for rationale).
      setConfirmingPrevBalance(useGameStore.getState().balance)
      setStatus('confirming')
      haptic('heavy')
    } catch (err) {
      console.error('USDT sendTransaction error:', err)
      const rawMsg = String(err?.message || err || '').trim()
      const userCancelled = /reject|cancel|user/i.test(rawMsg)
      const tail = rawMsg ? ' — ' + rawMsg.slice(0, 200) : ''
      setUsdtWalletError(userCancelled
        ? t.depositTonWalletCancelled
        : t.depositTonWalletFailed + tail)
      haptic('medium')
    } finally {
      setUsdtWalletSending(false)
    }
  }

  const memoTag = user?.telegram_id || user?.id || 'dev'
  const MIN_RUB = 200
  const minFormatted = formatCurrency(MIN_RUB, currency, rates, { approximate: true })

  // Crypto equivalent of 200 ₽:
  //   USDT — pegged to USD, so it equals 200 ₽ → USD via the
  //          existing fiat rate table.
  //   TON  — uses the live CoinGecko price (USD per 1 TON).
  //          200 ₽ → USD / tonPrice.
  // Returns null until tonPrice has resolved on first open.
  const minUsdt = (() => {
    const usd = convertFromRub(MIN_RUB, 'USD', rates)
    return usd > 0 ? usd : null
  })()
  const minTon = (() => {
    if (!tonPrice || tonPrice <= 0) return null
    const usd = convertFromRub(MIN_RUB, 'USD', rates)
    return usd > 0 ? usd / tonPrice : null
  })()

  // 2-decimal display for USDT, 3-decimal for TON (TON values
  // are smaller per unit so 3 decimals reads better).
  const fmtUsdt = minUsdt != null ? `${minUsdt.toFixed(2)} USDT` : null
  const fmtTon  = minTon  != null ? `${minTon.toFixed(3)} TON`  : null

  // ── Live fiat-equivalent helpers for the wallet-deposit views ──
  // Both helpers expect the entered coin amount as a string from
  // the input field. They convert coin → RUB and then run it
  // through formatCurrency so the displayed equivalent always
  // matches the user's selected fiat (RUB / USD / EUR / …),
  // never hardcoded rubles. Returns '' when the input is empty
  // or invalid so the JSX can hide the helper line cleanly.
  function tonAmountAsFiat(amountStr) {
    const n = Number(String(amountStr).replace(',', '.'))
    if (!Number.isFinite(n) || n <= 0 || !tonPrice || tonPrice <= 0) return ''
    const usd = n * tonPrice
    const rub = rates?.USD ? usd / rates.USD : 0
    if (rub <= 0) return ''
    return formatCurrency(rub, currency, rates, { approximate: true })
  }

  function usdtAmountAsFiat(amountStr) {
    const n = Number(String(amountStr).replace(',', '.'))
    if (!Number.isFinite(n) || n <= 0) return ''
    // USDT is pegged 1:1 with USD, so USDT amount == USD amount.
    const rub = rates?.USD ? n / rates.USD : 0
    if (rub <= 0) return ''
    return formatCurrency(rub, currency, rates, { approximate: true })
  }

  return (
    <>
      <div className={`deposit-overlay ${depositOpen ? 'visible' : ''}`} onClick={close} />

      <div className={`deposit-sheet ${depositOpen ? 'open' : ''}`}>
        <div className="deposit-handle" />

        {status !== 'success' && status !== 'confirming' && (
          <div className="deposit-header">
            {view !== 'main'
              ? <BackButton label={t.depositBack} onClick={goBack} />
              : <span className="deposit-title">{t.depositTitle}</span>
            }
            <button className="deposit-close" onClick={close}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
        )}

        {/* ── Confirming on-chain ── */}
        {/* Shown after sendTransaction resolves while we wait for
          * the realtime channel on `transactions` to fire. Same
          * card geometry as the success state but with a spinner
          * instead of the green check, so the layout doesn't jump
          * when we transition into success. */}
        {status === 'confirming' && (
          <div className="deposit-success">
            <div className="deposit-confirming-spinner" />
            <span className="deposit-success-title">{t.depositTonWalletConfirmingTitle}</span>
            <span className="deposit-success-sub">{t.depositTonWalletConfirmingSub}</span>
          </div>
        )}

        {/* ── Success ── */}
        {status === 'success' && (
          <div className="deposit-success">
            <SuccessCheckmark />
            <span className="deposit-success-title">{t.depositSuccess}</span>
            {successAmountRef.current > 0 && (
              <span className="deposit-success-amount">
                {formatCurrency(successAmountRef.current, currency, rates, { sign: '+' })}
              </span>
            )}
          </div>
        )}

        {/* ── Error ── */}
        {status === 'error' && (
          <div className="deposit-error">
            <div className="deposit-error-icon">✕</div>
            <span className="deposit-error-title">{t.depositError}</span>
            <button className="deposit-buy-btn" onClick={() => setStatus('idle')}>
              {t.depositRetry || t.depositBack}
            </button>
          </div>
        )}

        {/* ── Main ── */}
        {status === 'idle' && view === 'main' && (
          <div className="deposit-options">
            {!starsEnabled && !cryptoEnabled && (
              <div className="deposit-unavailable">
                <span>{lang === 'ru' ? 'Пополнение временно недоступно' : 'Deposits temporarily unavailable'}</span>
              </div>
            )}
            {starsEnabled && (
              <button
                type="button"
                className="deposit-coin-card deposit-coin-card--stars"
                onClick={() => { haptic('medium'); setView('stars') }}
              >
                {/* Big star icon bleeds out of the top-LEFT
                  * corner (mirror of the crypto cards whose icons
                  * bleed out the bottom-RIGHT). Same dark-gray
                  * card surface ties the row together visually. */}
                <img
                  className="deposit-coin-card-art deposit-coin-card-art--topleft"
                  src={tgStarSrc}
                  alt=""
                  draggable="false"
                />
                <div className="deposit-coin-card-text deposit-coin-card-text--right">
                  <span className="deposit-coin-card-name">{t.depositStars}</span>
                  <span className="deposit-coin-card-sub">{t.depositStarsSub}</span>
                </div>
                <svg
                  className="deposit-coin-card-arrow"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  aria-hidden="true"
                >
                  <path d="M9 18l6-6-6-6" />
                </svg>
              </button>
            )}
            {cryptoEnabled && (
              <>
                <span className="deposit-section-heading">{t.depositCrypto}</span>
                <div className="deposit-coin-grid">
                  {/* TON — left.
                    * Layout mirrors the reference design: text
                    * stacked top-left, big icon absolutely
                    * positioned bottom-right and partially clipped
                    * by the card's overflow:hidden. */}
                  <button
                    type="button"
                    className="deposit-coin-card deposit-coin-card--ton"
                    onClick={() => { haptic('medium'); setView('ton') }}
                  >
                    <div className="deposit-coin-card-text">
                      <span className="deposit-coin-card-name">{t.depositCryptoTon}</span>
                      <span className="deposit-coin-card-sub">{t.depositCryptoTonSub}</span>
                    </div>
                    <img
                      className="deposit-coin-card-art"
                      src={tonIconSrc}
                      alt=""
                      draggable="false"
                    />
                  </button>

                  {/* USDT (TON) — right. Same layout; the icon
                    * is the USDT disc + a small TON network
                    * badge in the bottom-right corner of the
                    * USDT disc. */}
                  <button
                    type="button"
                    className="deposit-coin-card deposit-coin-card--usdt"
                    onClick={() => { haptic('medium'); setView('usdt') }}
                  >
                    {/* TON network badge pinned to the CARD's
                      * top-right corner (not to the icon) — so
                      * it sits as a separate "network" marker
                      * above the USDT disc, matching the latest
                      * spec from the user. */}
                    <img
                      className="deposit-coin-card-net-badge"
                      src={tonBadgeSrc}
                      alt=""
                      draggable="false"
                    />
                    <div className="deposit-coin-card-text">
                      <span className="deposit-coin-card-name">{t.depositCryptoUsdt}</span>
                      <span className="deposit-coin-card-sub">{t.depositCryptoUsdtSub}</span>
                    </div>
                    <img
                      className="deposit-coin-card-art"
                      src={usdtIconSrc}
                      alt=""
                      draggable="false"
                    />
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {/* ── Stars ── */}
        {status === 'idle' && view === 'stars' && (
          <div className="deposit-stars-view">
            <p className="deposit-stars-subtitle">{t.depositStarsTitle}</p>

            <div className="deposit-presets">
              {PRESETS.map(amount => (
                <button
                  key={amount}
                  className={`deposit-preset ${selected === amount && custom === '' ? 'active' : ''}`}
                  onClick={() => handlePreset(amount)}
                >
                  <span className="deposit-preset-stars"><TgStarIcon size={30} /> {amount}</span>
                  <span className="deposit-preset-rub">{formatCurrency(amount, currency, rates, { approximate: true })}</span>
                </button>
              ))}
            </div>

            <div className="deposit-custom-wrap">
              <span className="deposit-custom-label">{t.depositCustom}</span>
              <div className={`deposit-custom-input-wrap ${custom !== '' && !isCustomValid ? 'error' : ''} ${custom !== '' && isCustomValid ? 'filled' : ''}`}>
                <span className="deposit-custom-star"><TgStarIcon size={30} /></span>
                <input
                  className="deposit-custom-input"
                  type="number"
                  inputMode="numeric"
                  placeholder={t.depositCustomPlaceholder}
                  value={custom}
                  min={MIN_STARS}
                  onChange={handleCustomChange}
                />
                {custom !== '' && isCustomValid && (
                  <span className="deposit-custom-rub">{formatCurrency(Number(custom), currency, rates, { approximate: true })}</span>
                )}
              </div>
            </div>

            <button className={`deposit-buy-btn ${loading ? 'loading' : ''}`} disabled={!canBuy} onClick={handleBuy}>
              {loading ? (
                <div className="deposit-btn-spinner" />
              ) : (
                <>{t.depositBuy} {activeAmount >= MIN_STARS ? activeAmount : '—'} <TgStarIcon size={32} /></>

              )}
            </button>
          </div>
        )}

        {/* ── TON deposit details ── */}
        {status === 'idle' && view === 'ton' && (
          <div className="deposit-crypto-detail">
            <div className="deposit-crypto-hero deposit-crypto-hero--ton" style={{ '--coin-color': '#0098EA' }}>
              <div className="deposit-crypto-hero-icon">
                {/* Larger TON icon (56 px) — user wanted the TON
                  * hero icon bumped up beyond the default. */}
                <SmallTonIcon size={56} />
              </div>
              <div className="deposit-crypto-hero-text">
                <span className="deposit-crypto-hero-name">TON</span>
                <span className="deposit-crypto-hero-net">{t.depositCryptoTonNet}</span>
              </div>
            </div>

            <div className="deposit-field" onClick={() => handleCopy(TON_ADDRESS, 'address')}>
              <span className="deposit-field-label">{t.depositCryptoAddress}</span>
              <div className="deposit-field-row">
                <span className="deposit-field-mono">{TON_ADDRESS}</span>
                <span className={`deposit-field-copy ${copiedField === 'address' ? 'copied' : ''}`}>
                  {copiedField === 'address' ? t.depositCryptoCopied : (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="9" y="9" width="13" height="13" rx="2" />
                      <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
                    </svg>
                  )}
                </span>
              </div>
            </div>

            <div className="deposit-field" onClick={() => handleCopy(String(memoTag), 'memo')}>
              <span className="deposit-field-label">{t.depositCryptoMemo}</span>
              <div className="deposit-field-row">
                <span className="deposit-field-memo">{memoTag}</span>
                <span className={`deposit-field-copy ${copiedField === 'memo' ? 'copied' : ''}`}>
                  {copiedField === 'memo' ? t.depositCryptoCopied : (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="9" y="9" width="13" height="13" rx="2" />
                      <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
                    </svg>
                  )}
                </span>
              </div>
            </div>

            <div className="deposit-crypto-info-block">
              <div className="deposit-crypto-info-row">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>
                <span>
                  {t.depositCryptoMin}: <strong>{minFormatted}</strong>
                  {view === 'usdt' && fmtUsdt && <span className="deposit-crypto-min-crypto">{' · ≈ '}{fmtUsdt}</span>}
                  {view === 'ton'  && fmtTon  && <span className="deposit-crypto-min-crypto">{' · ≈ '}{fmtTon}</span>}
                </span>
              </div>
              <div className="deposit-crypto-info-row">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
                <span>{t.depositCryptoWarn3}</span>
              </div>
            </div>

            <div className="deposit-crypto-warnings-block">
              <p>{t.depositCryptoWarn1.replace('{coin}', 'TON').replace('{network}', 'Toncoin')}</p>
              <p>{t.depositCryptoWarn2}</p>
            </div>

            {/* TON Connect CTA — sits at the bottom of the TON
              * detail view so the user can either copy the address
              * (top) OR pay in one tap via their connected wallet
              * (bottom). Swaps copy + click target based on
              * whether a TON wallet is currently bound to this
              * Mini App. */}
            <button
              className="deposit-tonconnect-btn"
              onClick={isTonWalletConnected
                ? () => { haptic('medium'); setView('ton-wallet') }
                : handleConnectTonWallet}
            >
              <SmallTonIcon size={22} />
              <span>
                {isTonWalletConnected ? t.depositTonTopUpViaWallet : t.depositTonConnect}
              </span>
            </button>
          </div>
        )}

        {/* ── TON Connect deposit (one-tap pay via connected wallet) ── */}
        {status === 'idle' && view === 'ton-wallet' && (
          <div className="deposit-crypto-detail deposit-tonwallet-view">
            <span className="deposit-tonwallet-title">{t.depositTonWalletTitle}</span>

            {/* Connected wallet card — TON icon + balance + Log Out.
              * Mirrors the bottom-sheet design from the spec
              * screenshot the user shared. */}
            <div className="deposit-tonwallet-card">
              <div className="deposit-tonwallet-card-left">
                <SmallTonIcon size={36} />
                <div className="deposit-tonwallet-card-text">
                  <span className="deposit-tonwallet-card-label">{t.depositTonWalletBalance}</span>
                  <span className="deposit-tonwallet-card-balance">
                    {tonWalletBalance != null ? tonWalletBalance.toFixed(2) : '—'}
                  </span>
                </div>
              </div>
              <button
                className="deposit-tonwallet-logout"
                onClick={handleDisconnectTonWallet}
              >
                {t.depositTonWalletLogout}
              </button>
            </div>

            <div className="deposit-tonwallet-amount-wrap">
              <input
                className="deposit-tonwallet-amount-input"
                type="text"
                inputMode="decimal"
                placeholder={t.depositTonWalletAmount}
                value={tonWalletAmount}
                onChange={(e) => {
                  const v = e.target.value.replace(/[^\d.,]/g, '').replace(',', '.')
                  setTonWalletAmount(v)
                  if (tonWalletError) setTonWalletError('')
                }}
              />
              <span className="deposit-tonwallet-amount-coin">TON</span>
            </div>

            {/* Min-coin hint + live fiat-equivalent (in the user's
              * selected currency — RUB / USD / EUR). Hint stays
              * visible always; equivalent only shows once a valid
              * amount is in the input. */}
            <div className="deposit-tonwallet-meta">
              <span className="deposit-tonwallet-min">
                {t.depositTonWalletMin.replace('{min}', (minTon ?? MIN_TON_FALLBACK).toFixed(3))}
              </span>
              {tonAmountAsFiat(tonWalletAmount) && (
                <span className="deposit-tonwallet-fiat">
                  {tonAmountAsFiat(tonWalletAmount)}
                </span>
              )}
            </div>

            {tonWalletError && (
              <div className="deposit-tonwallet-error">{tonWalletError}</div>
            )}

            <button
              className={`deposit-tonwallet-submit ${tonWalletSending ? 'loading' : ''}`}
              onClick={handleTonWalletSend}
              disabled={tonWalletSending || !tonWalletAmount}
            >
              {tonWalletSending
                ? <div className="deposit-btn-spinner" />
                : t.depositTonWalletContinue}
            </button>
          </div>
        )}

        {/* ── USDT TON Connect deposit (one-tap pay via connected wallet) ── */}
        {status === 'idle' && view === 'usdt-wallet' && (
          <div className="deposit-crypto-detail deposit-tonwallet-view">
            <span className="deposit-tonwallet-title">{t.depositUsdtWalletTitle}</span>

            <div className="deposit-tonwallet-card">
              <div className="deposit-tonwallet-card-left">
                <SmallUsdtIcon size={36} />
                <div className="deposit-tonwallet-card-text">
                  <span className="deposit-tonwallet-card-label">{t.depositTonWalletBalance}</span>
                  <span className="deposit-tonwallet-card-balance">
                    {usdtWalletBalance != null ? usdtWalletBalance.toFixed(2) : '—'}
                  </span>
                </div>
              </div>
              <button
                className="deposit-tonwallet-logout"
                onClick={handleDisconnectTonWallet}
              >
                {t.depositTonWalletLogout}
              </button>
            </div>

            <div className="deposit-tonwallet-amount-wrap">
              <input
                className="deposit-tonwallet-amount-input"
                type="text"
                inputMode="decimal"
                placeholder={t.depositTonWalletAmount}
                value={usdtWalletAmount}
                onChange={(e) => {
                  const v = e.target.value.replace(/[^\d.,]/g, '').replace(',', '.')
                  setUsdtWalletAmount(v)
                  if (usdtWalletError) setUsdtWalletError('')
                }}
              />
              <span className="deposit-tonwallet-amount-coin">USDT</span>
            </div>

            <div className="deposit-tonwallet-meta">
              <span className="deposit-tonwallet-min">
                {t.depositUsdtWalletMin.replace('{min}', (minUsdt ?? MIN_USDT_FALLBACK).toFixed(2))}
              </span>
              {usdtAmountAsFiat(usdtWalletAmount) && (
                <span className="deposit-tonwallet-fiat">
                  {usdtAmountAsFiat(usdtWalletAmount)}
                </span>
              )}
            </div>

            {usdtWalletError && (
              <div className="deposit-tonwallet-error">{usdtWalletError}</div>
            )}

            <button
              className={`deposit-tonwallet-submit ${usdtWalletSending ? 'loading' : ''}`}
              onClick={handleUsdtWalletSend}
              disabled={usdtWalletSending || !usdtWalletAmount}
            >
              {usdtWalletSending
                ? <div className="deposit-btn-spinner" />
                : t.depositTonWalletContinue}
            </button>
          </div>
        )}

        {/* ── USDT (TON) deposit details ── */}
        {status === 'idle' && view === 'usdt' && (
          <div className="deposit-crypto-detail">
            <div className="deposit-crypto-hero" style={{ '--coin-color': '#26A17B' }}>
              <div className="deposit-crypto-hero-icon">
                {/* Bare USDT disc — same 56 px size as the TON
                  * detail's SmallTonIcon, no stacked badge or
                  * background card around it. */}
                <SmallUsdtIcon size={56} />
              </div>
              <div className="deposit-crypto-hero-text">
                <span className="deposit-crypto-hero-name">USDT</span>
                <span className="deposit-crypto-hero-net">{t.depositCryptoUsdtNet}</span>
              </div>
            </div>

            <div className="deposit-field" onClick={() => handleCopy(USDT_ADDRESS, 'address')}>
              <span className="deposit-field-label">{t.depositCryptoAddress}</span>
              <div className="deposit-field-row">
                <span className="deposit-field-mono">{USDT_ADDRESS}</span>
                <span className={`deposit-field-copy ${copiedField === 'address' ? 'copied' : ''}`}>
                  {copiedField === 'address' ? t.depositCryptoCopied : (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="9" y="9" width="13" height="13" rx="2" />
                      <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
                    </svg>
                  )}
                </span>
              </div>
            </div>

            <div className="deposit-field" onClick={() => handleCopy(String(memoTag), 'memo')}>
              <span className="deposit-field-label">{t.depositCryptoMemo}</span>
              <div className="deposit-field-row">
                <span className="deposit-field-memo">{memoTag}</span>
                <span className={`deposit-field-copy ${copiedField === 'memo' ? 'copied' : ''}`}>
                  {copiedField === 'memo' ? t.depositCryptoCopied : (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="9" y="9" width="13" height="13" rx="2" />
                      <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
                    </svg>
                  )}
                </span>
              </div>
            </div>

            <div className="deposit-crypto-info-block">
              <div className="deposit-crypto-info-row">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>
                <span>
                  {t.depositCryptoMin}: <strong>{minFormatted}</strong>
                  {view === 'usdt' && fmtUsdt && <span className="deposit-crypto-min-crypto">{' · ≈ '}{fmtUsdt}</span>}
                  {view === 'ton'  && fmtTon  && <span className="deposit-crypto-min-crypto">{' · ≈ '}{fmtTon}</span>}
                </span>
              </div>
              <div className="deposit-crypto-info-row">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
                <span>{t.depositCryptoWarn3}</span>
              </div>
            </div>

            <div className="deposit-crypto-warnings-block">
              <p>{t.depositCryptoWarn1Usdt}</p>
              <p>{t.depositCryptoWarn2}</p>
            </div>

            {/* TON Connect CTA — same as TON detail. Tap to either
              * connect a TON wallet (which can sign jetton
              * transfers too) or hop straight into the USDT pay
              * view if a wallet is already bound. */}
            <button
              className="deposit-tonconnect-btn deposit-tonconnect-btn--usdt"
              onClick={isTonWalletConnected
                ? () => { haptic('medium'); setView('usdt-wallet') }
                : handleConnectTonWallet}
            >
              <SmallUsdtIcon size={22} />
              <span>
                {isTonWalletConnected ? t.depositTonTopUpViaWallet : t.depositTonConnect}
              </span>
            </button>
          </div>
        )}
      </div>
    </>
  )
}

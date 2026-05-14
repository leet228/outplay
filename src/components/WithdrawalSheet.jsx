import { useEffect, useState } from 'react'
import useGameStore from '../store/useGameStore'
import { haptic } from '../lib/telegram'
import { formatCurrency, convertFromRub } from '../lib/currency'
import { translations } from '../lib/i18n'
import { requestWithdrawal, requestUsdtWithdrawal } from '../lib/supabase'
import tonIconSrc    from '../assets/crypto/ton.svg'
import usdtIconSrc   from '../assets/crypto/usdt.svg'
import tonBadgeSrc   from '../assets/crypto/small_ton_for_usdt.svg'
import smallTonSrc   from '../assets/crypto/small_ton.svg'
import smallUsdtSrc  from '../assets/crypto/small_usdt.svg'
// The withdraw sheet reuses the deposit sheet's coin-picker
// styles (`.deposit-coin-card` / `.deposit-coin-card-art` etc.)
// so the two sheets feel like one consistent surface. Importing
// the CSS here guarantees the rules ship even if the user
// opens Withdraw before Deposit.
import './DepositSheet.css'
import './WithdrawalSheet.css'

const MIN_WITHDRAW_RUB = 500
// Combined network fee: includes gas + 1% platform fee.
// TON path mirrors request_withdrawal: 0.01 TON @ 250 ₽/TON ≈ 2.5 ₽.
// USDT path mirrors request_usdt_withdrawal: jetton-wallet hop +
// recipient notification cost ~0.07 TON, fixed at 25 ₽ server-side.
const FEE_PERCENT = 0.01
const GAS_TON = 0.01
const TON_RUB_PRICE = 250
const GAS_RUB_USDT = 25

// Brand icons shared with the deposit sheet.
function TonIcon({ size = 22 }) {
  return <img src={smallTonSrc} width={size} height={size} alt="" draggable="false" />
}

function UsdtIcon({ size = 22 }) {
  return <img src={smallUsdtSrc} width={size} height={size} alt="" draggable="false" />
}

function SuccessCheckmark() {
  return (
    <div className="wd-success-circle">
      <svg className="wd-success-check" width="48" height="48" viewBox="0 0 48 48" fill="none">
        <path d="M12 25L20 33L36 15" stroke="#22c55e" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  )
}

function isValidTonAddress(addr) {
  if (!addr) return false
  const trimmed = addr.trim()
  // User-friendly: UQ... or EQ... (48 chars base64)
  if (/^[UE]Q[A-Za-z0-9_-]{46}$/.test(trimmed)) return true
  // Raw: 0:hex (64 hex chars)
  if (/^0:[a-fA-F0-9]{64}$/.test(trimmed)) return true
  return false
}

export default function WithdrawalSheet() {
  const { withdrawalOpen, setWithdrawalOpen, lang, currency, rates, balance, user, setBalance } = useGameStore()
  const t = translations[lang]

  // View state mirrors the deposit sheet:
  //   'picker' — coin grid (TON / USDT-Toncoin)
  //   'ton'    — TON withdraw form (the existing working flow)
  //   'usdt'   — USDT (Toncoin) "coming soon" stub
  const [view, setView] = useState('picker')
  const [wallet, setWallet] = useState('')
  const [memo, setMemo] = useState('')
  const [amount, setAmount] = useState('')
  const [status, setStatus] = useState('idle') // 'idle' | 'loading' | 'success' | 'error'
  const [errorMsg, setErrorMsg] = useState('')
  const [walletTouched, setWalletTouched] = useState(false)
  const [amountTouched, setAmountTouched] = useState(false)

  // Convert min withdrawal to user currency for display
  const minInCurrency = convertFromRub(MIN_WITHDRAW_RUB, currency.code, rates)
  const maxInCurrency = convertFromRub(balance, currency.code, rates)
  // Gas math is view-aware: USDT withdraws pay a flat 25 ₽ to
  // cover the on-chain jetton-transfer hop, TON withdraws pay
  // ~2.5 ₽ for a plain TON message.
  const gasInRub = view === 'usdt' ? GAS_RUB_USDT : GAS_TON * TON_RUB_PRICE

  const numAmount = Number(amount) || 0
  // Convert user input back to RUB for validation
  const amountInRub = currency.code === 'RUB' ? numAmount : (rates[currency.code] ? numAmount / rates[currency.code] : numAmount)

  const fee = Math.round(amountInRub * FEE_PERCENT)
  const gasDisplay = gasInRub
  const totalFee = fee + Math.round(gasDisplay)
  const netRub = amountInRub - totalFee
  const netDisplay = netRub > 0 ? netRub : 0

  const walletValid = isValidTonAddress(wallet)
  const amountValid = amountInRub >= MIN_WITHDRAW_RUB && amountInRub <= balance
  const canSubmit = walletValid && amountValid && numAmount > 0

  const close = () => {
    haptic('light')
    setWithdrawalOpen(false)
  }

  // Reset on close
  useEffect(() => {
    if (!withdrawalOpen) {
      setTimeout(() => {
        setView('picker')
        setWallet('')
        setMemo('')
        setAmount('')
        setStatus('idle')
        setErrorMsg('')
        setWalletTouched(false)
        setAmountTouched(false)
      }, 300)
    }
  }, [withdrawalOpen])

  // Telegram BackButton — back inside the sheet goes from a
  // detail view to the picker; from the picker it closes.
  useEffect(() => {
    const tg = window.Telegram?.WebApp
    if (!tg) return
    if (withdrawalOpen) {
      tg.BackButton.show()
      const handler = () => {
        haptic('light')
        if (view === 'ton' || view === 'usdt') {
          setView('picker')
        } else {
          close()
        }
      }
      tg.BackButton.onClick(handler)
      return () => { tg.BackButton.offClick(handler) }
    } else {
      tg.BackButton.hide()
    }
  }, [withdrawalOpen, view])

  // Auto-close after success
  useEffect(() => {
    if (status === 'success') {
      const timer = setTimeout(() => setWithdrawalOpen(false), 2500)
      return () => clearTimeout(timer)
    }
  }, [status])

  function handleAmountChange(e) {
    const val = e.target.value.replace(/[^\d.,]/g, '').replace(',', '.')
    setAmount(val)
    if (!amountTouched) setAmountTouched(true)
  }

  function handleMaxClick() {
    haptic('light')
    if (currency.code === 'RUB') {
      setAmount(String(balance))
    } else {
      setAmount(maxInCurrency.toFixed(2))
    }
    setAmountTouched(true)
  }

  async function handleSubmit() {
    if (!canSubmit || status === 'loading') return
    haptic('medium')
    setStatus('loading')
    setErrorMsg('')

    try {
      const amountRub = Math.round(amountInRub)
      // Dispatch by view — both RPCs share the same shape and
      // return identical error codes so the handling below is
      // a single code path.
      const submit = view === 'usdt' ? requestUsdtWithdrawal : requestWithdrawal
      const result = await submit(user.id, amountRub, wallet.trim(), memo.trim())

      if (result?.error) {
        setStatus('error')
        const errMap = {
          min_amount: t.withdrawMin?.replace('{amount}', fmtMin()) || 'Minimum not met',
          insufficient_balance: t.withdrawInsufficientBalance,
          user_not_found: 'User not found',
          amount_too_small_after_fees: lang === 'ru' ? 'Сумма слишком мала после вычета комиссии' : 'Amount too small after fees',
        }
        setErrorMsg(errMap[result.error] || result.error)
        return
      }

      // Success — update local balance
      if (result?.new_balance != null) {
        setBalance(result.new_balance)
      }
      setStatus('success')
      try { window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred('success') } catch {}
    } catch (err) {
      console.error('Withdrawal error:', err)
      setStatus('error')
      setErrorMsg(lang === 'ru' ? 'Ошибка при создании заявки' : 'Failed to create withdrawal')
    }
  }

  // Format helpers
  function fmtMin() {
    return formatCurrency(MIN_WITHDRAW_RUB, currency, rates)
  }
  function fmtMax() {
    return formatCurrency(balance, currency, rates)
  }
  function fmtTotalFee() {
    return formatCurrency(totalFee, currency, rates)
  }
  function fmtReceive() {
    return formatCurrency(netDisplay, currency, rates)
  }

  const showWalletError = walletTouched && wallet.length > 0 && !walletValid
  const showAmountError = amountTouched && numAmount > 0 && !amountValid

  return (
    <>
      <div className={`wd-overlay ${withdrawalOpen ? 'visible' : ''}`} onClick={close} />

      <div className={`wd-sheet ${withdrawalOpen ? 'open' : ''}`}>
        <div className="wd-handle" />

        {/* Success */}
        {status === 'success' && (
          <div className="wd-success">
            <SuccessCheckmark />
            <span className="wd-success-title">{t.withdrawSuccess}</span>
            <span className="wd-success-sub">{t.withdrawSuccessSub}</span>
          </div>
        )}

        {/* Error */}
        {status === 'error' && (
          <div className="wd-success">
            <div className="wd-success-circle" style={{ background: 'rgba(239, 68, 68, 0.12)' }}>
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="2.5" strokeLinecap="round">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </div>
            <span className="wd-success-title">{lang === 'ru' ? 'Ошибка' : 'Error'}</span>
            <span className="wd-success-sub">{errorMsg}</span>
            <button className="wd-submit-btn" style={{ marginTop: 8 }} onClick={() => setStatus('idle')}>
              {lang === 'ru' ? 'Попробовать снова' : 'Try again'}
            </button>
          </div>
        )}

        {/* Coin picker — first view the user lands on. Reuses
          * the deposit sheet's coin-card layout so the two
          * sheets read as one consistent surface. */}
        {(status === 'idle' || status === 'loading') && view === 'picker' && (
          <>
            <div className="wd-header">
              <span className="wd-title">{t.withdrawTitle}</span>
              <button className="wd-close" onClick={close}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="wd-body">
              <span className="deposit-section-heading">{t.withdrawChooseCoin}</span>
              <div className="deposit-coin-grid">
                {/* TON — left, fully working */}
                <button
                  type="button"
                  className="deposit-coin-card deposit-coin-card--ton"
                  onClick={() => { haptic('medium'); setView('ton') }}
                >
                  <div className="deposit-coin-card-text">
                    <span className="deposit-coin-card-name">{t.depositCryptoTon}</span>
                    <span className="deposit-coin-card-sub">{t.depositCryptoTonSub}</span>
                  </div>
                  <img className="deposit-coin-card-art" src={tonIconSrc} alt="" draggable="false" />
                </button>

                {/* USDT (Toncoin) — right, stub. Card looks
                  * identical to the deposit USDT card (TON
                  * badge in the corner) so users have one
                  * mental model across deposit and withdraw. */}
                <button
                  type="button"
                  className="deposit-coin-card deposit-coin-card--usdt"
                  onClick={() => { haptic('medium'); setView('usdt') }}
                >
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
                  <img className="deposit-coin-card-art" src={usdtIconSrc} alt="" draggable="false" />
                </button>
              </div>
            </div>
          </>
        )}

        {/* USDT (Toncoin) detail — full form mirroring the TON
          * flow, but with a green banner and a disabled submit
          * button. Wallet address / memo / amount fields share
          * state and handlers with the TON form because USDT
          * deposits also use a TON wallet address. The submit
          * is intentionally inert until the highload jetton-
          * transfer signer ships server-side. */}
        {(status === 'idle' || status === 'loading') && view === 'usdt' && (
          <>
            <div className="wd-header">
              <button className="wd-back" onClick={() => { haptic('light'); setView('picker') }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round">
                  <path d="M15 18l-6-6 6-6" />
                </svg>
                {t.withdrawBack}
              </button>
              <button className="wd-close" onClick={close}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="wd-body">
              {/* Green USDT banner — same layout / typography
                * as the TON banner so the two coin flows feel
                * symmetric. */}
              <div className="wd-usdt-banner">
                <div className="wd-ton-icon">
                  <img src={smallUsdtSrc} width={56} height={56} alt="" draggable="false" />
                </div>
                <div className="wd-ton-text">
                  <span className="wd-ton-title">USDT</span>
                  <span className="wd-ton-desc">{t.withdrawUsdtDesc}</span>
                </div>
              </div>

              {/* Wallet address — same TON address format. */}
              <div className="wd-field">
                <label className="wd-label">{t.withdrawWallet}</label>
                <div className={`wd-input-wrap ${showWalletError ? 'error' : wallet && walletValid ? 'valid' : ''}`}>
                  <input
                    className="wd-input"
                    type="text"
                    placeholder={t.withdrawWalletPlaceholder}
                    value={wallet}
                    onChange={e => setWallet(e.target.value)}
                    onBlur={() => setWalletTouched(true)}
                    autoComplete="off"
                    spellCheck="false"
                  />
                  {wallet && walletValid && (
                    <svg className="wd-input-icon valid" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="2.5" strokeLinecap="round">
                      <path d="M20 6L9 17l-5-5"/>
                    </svg>
                  )}
                </div>
                {showWalletError && (
                  <span className="wd-field-error">{t.withdrawInvalidAddress}</span>
                )}
              </div>

              {/* Memo */}
              <div className="wd-field">
                <label className="wd-label">{t.withdrawMemo}</label>
                <div className="wd-input-wrap">
                  <input
                    className="wd-input"
                    type="text"
                    placeholder={t.withdrawMemoPlaceholder}
                    value={memo}
                    onChange={e => setMemo(e.target.value)}
                    autoComplete="off"
                  />
                </div>
              </div>

              {/* Amount */}
              <div className="wd-field">
                <label className="wd-label">{t.withdrawAmount}</label>
                <div className={`wd-input-wrap wd-amount-wrap ${showAmountError ? 'error' : numAmount > 0 && amountValid ? 'valid' : ''}`}>
                  <input
                    className="wd-input wd-amount-input"
                    type="text"
                    inputMode="decimal"
                    placeholder={currency.code === 'RUB' ? '0' : '0.00'}
                    value={amount}
                    onChange={handleAmountChange}
                    onBlur={() => setAmountTouched(true)}
                  />
                  <span className="wd-amount-symbol">{currency.symbol}</span>
                  <button className="wd-max-btn" onClick={handleMaxClick}>MAX</button>
                </div>
                <div className="wd-amount-hint">
                  <span>{t.withdrawMinLabel} {fmtMin()}</span>
                  <span>{t.withdrawMaxLabel} {fmtMax()}</span>
                </div>
                {showAmountError && amountInRub < MIN_WITHDRAW_RUB && (
                  <span className="wd-field-error">{t.withdrawMin.replace('{amount}', fmtMin())}</span>
                )}
                {showAmountError && amountInRub > balance && (
                  <span className="wd-field-error">{t.withdrawInsufficientBalance}</span>
                )}
              </div>

              {/* Fee breakdown — identical math to TON since
                * the wire fee is paid in TON regardless of
                * which jetton we're sending. */}
              {numAmount > 0 && amountValid && (
                <div className="wd-fees">
                  <div className="wd-fee-row">
                    <span className="wd-fee-label">{t.withdrawGas}</span>
                    <span className="wd-fee-value">-{fmtTotalFee()}</span>
                  </div>
                  <div className="wd-fee-divider" />
                  <div className="wd-fee-row wd-fee-total">
                    <span className="wd-fee-label">{t.withdrawReceive}</span>
                    <span className="wd-fee-value wd-fee-receive">{fmtReceive()}</span>
                  </div>
                </div>
              )}

              {/* Submit — real handler now that the Edge
                * Function signs jetton transfers. Same loading
                * / disabled gating as the TON form. */}
              <button
                className="wd-submit-btn"
                disabled={!canSubmit || status === 'loading'}
                onClick={handleSubmit}
              >
                {status === 'loading' ? (
                  <div className="wd-btn-spinner" />
                ) : (
                  <>{t.withdrawBtn} <UsdtIcon size={18} /></>
                )}
              </button>
            </div>
          </>
        )}

        {/* TON detail — the existing working withdraw form. */}
        {(status === 'idle' || status === 'loading') && view === 'ton' && (
          <>
            <div className="wd-header">
              <button className="wd-back" onClick={() => { haptic('light'); setView('picker') }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round">
                  <path d="M15 18l-6-6 6-6" />
                </svg>
                {t.withdrawBack}
              </button>
              <button className="wd-close" onClick={close}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="wd-body">
              {/* TON info banner — bare 56 px icon (no blue
                * tint square behind it), title "TON", two-line
                * description from i18n. */}
              <div className="wd-ton-banner">
                <div className="wd-ton-icon">
                  <TonIcon size={56} />
                </div>
                <div className="wd-ton-text">
                  <span className="wd-ton-title">TON</span>
                  <span className="wd-ton-desc">{t.withdrawDesc}</span>
                </div>
              </div>

              {/* Wallet address */}
              <div className="wd-field">
                <label className="wd-label">{t.withdrawWallet}</label>
                <div className={`wd-input-wrap ${showWalletError ? 'error' : wallet && walletValid ? 'valid' : ''}`}>
                  <input
                    className="wd-input"
                    type="text"
                    placeholder={t.withdrawWalletPlaceholder}
                    value={wallet}
                    onChange={e => setWallet(e.target.value)}
                    onBlur={() => setWalletTouched(true)}
                    autoComplete="off"
                    spellCheck="false"
                  />
                  {wallet && walletValid && (
                    <svg className="wd-input-icon valid" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="2.5" strokeLinecap="round">
                      <path d="M20 6L9 17l-5-5"/>
                    </svg>
                  )}
                </div>
                {showWalletError && (
                  <span className="wd-field-error">{t.withdrawInvalidAddress}</span>
                )}
              </div>

              {/* Memo */}
              <div className="wd-field">
                <label className="wd-label">{t.withdrawMemo}</label>
                <div className="wd-input-wrap">
                  <input
                    className="wd-input"
                    type="text"
                    placeholder={t.withdrawMemoPlaceholder}
                    value={memo}
                    onChange={e => setMemo(e.target.value)}
                    autoComplete="off"
                  />
                </div>
              </div>

              {/* Amount */}
              <div className="wd-field">
                <label className="wd-label">{t.withdrawAmount}</label>
                <div className={`wd-input-wrap wd-amount-wrap ${showAmountError ? 'error' : numAmount > 0 && amountValid ? 'valid' : ''}`}>
                  <input
                    className="wd-input wd-amount-input"
                    type="text"
                    inputMode="decimal"
                    placeholder={currency.code === 'RUB' ? '0' : '0.00'}
                    value={amount}
                    onChange={handleAmountChange}
                    onBlur={() => setAmountTouched(true)}
                  />
                  <span className="wd-amount-symbol">{currency.symbol}</span>
                  <button className="wd-max-btn" onClick={handleMaxClick}>MAX</button>
                </div>
                <div className="wd-amount-hint">
                  <span>{t.withdrawMinLabel} {fmtMin()}</span>
                  <span>{t.withdrawMaxLabel} {fmtMax()}</span>
                </div>
                {showAmountError && amountInRub < MIN_WITHDRAW_RUB && (
                  <span className="wd-field-error">{t.withdrawMin.replace('{amount}', fmtMin())}</span>
                )}
                {showAmountError && amountInRub > balance && (
                  <span className="wd-field-error">{t.withdrawInsufficientBalance}</span>
                )}
              </div>

              {/* Fee breakdown — only show when amount is valid */}
              {numAmount > 0 && amountValid && (
                <div className="wd-fees">
                  <div className="wd-fee-row">
                    <span className="wd-fee-label">{t.withdrawGas}</span>
                    <span className="wd-fee-value">-{fmtTotalFee()}</span>
                  </div>
                  <div className="wd-fee-divider" />
                  <div className="wd-fee-row wd-fee-total">
                    <span className="wd-fee-label">{t.withdrawReceive}</span>
                    <span className="wd-fee-value wd-fee-receive">{fmtReceive()}</span>
                  </div>
                </div>
              )}

              {/* Submit */}
              <button
                className="wd-submit-btn"
                disabled={!canSubmit || status === 'loading'}
                onClick={handleSubmit}
              >
                {status === 'loading' ? (
                  <div className="wd-btn-spinner" />
                ) : (
                  <>{t.withdrawBtn} <TonIcon size={18} /></>
                )}
              </button>
            </div>
          </>
        )}
      </div>
    </>
  )
}

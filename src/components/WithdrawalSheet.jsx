import { useEffect, useState } from 'react'
import useGameStore from '../store/useGameStore'
import { haptic } from '../lib/telegram'
import { formatCurrency, convertFromRub } from '../lib/currency'
import { translations } from '../lib/i18n'
import { requestWithdrawal, requestUsdtWithdrawal, requestCryptoWithdrawal, getCryptoWithdrawCfg } from '../lib/supabase'
import tonIconSrc    from '../assets/crypto/ton.svg'
import usdtIconSrc   from '../assets/crypto/usdt.svg'
import trxIconSrc    from '../assets/crypto/trx.svg'
import ethIconSrc    from '../assets/crypto/eth.svg'
import usdcIconSrc   from '../assets/crypto/usdc.svg'
import tonBadgeSrc   from '../assets/crypto/small_ton_for_usdt.svg'
import trxBadgeSrc   from '../assets/crypto/small_trx_for_usdt.svg'
import ethBadgeSrc   from '../assets/crypto/small_eth_for_usdt.svg'
import bnbBadgeSrc   from '../assets/crypto/small_bnb_for_usdt.svg'
import smallTonSrc   from '../assets/crypto/small_ton.svg'
import smallUsdtSrc  from '../assets/crypto/small_usdt.svg'
import smallTrxSrc   from '../assets/crypto/small_trx.svg'
import smallEthSrc   from '../assets/crypto/small_eth.svg'
import smallUsdcSrc  from '../assets/crypto/small_usdc.svg'
// The withdraw sheet reuses the deposit sheet's coin-picker styles.
import './DepositSheet.css'
import './WithdrawalSheet.css'

// Fixed fee model for the TON-family rails (unchanged, proven).
const FEE_PERCENT   = 0.01
const GAS_TON       = 0.01
const TON_RUB_PRICE = 250
const GAS_RUB_USDT  = 25
const TON_MIN_RUB   = 500

// The 8 withdrawal coins (mirrors the reference wallet exactly).
// kind: 'ton' | 'usdt-ton' → existing RPCs; 'crypto' → the new
// multi-chain queue (chain = treasury-withdraw key). addr: which
// address validator to use. badge = network chip on the card.
// `desc` is per-coin so the detail screen names the RIGHT network
// (not "Toncoin" for everything). `ph` is the address placeholder
// for that coin's address format.
const ADDR_PH = { ton: 'UQ... / EQ...', evm: '0x...', tron: 'T...' }
const COINS = [
  { id: 'ton',        kind: 'ton',       name: 'TON',  sub: 'Toncoin',   sym: 'TON',  addr: 'ton',  hero: smallTonSrc,  art: tonIconSrc,  badge: null,
    desc: { ru: 'Сеть TON (Toncoin)\nУкажите адрес TON-кошелька', en: 'TON (Toncoin) network\nEnter your TON wallet address' } },
  { id: 'usdt-ton',   kind: 'usdt-ton',  name: 'USDT', sub: 'Toncoin',   sym: 'USDT', addr: 'ton',  hero: smallUsdtSrc, art: usdtIconSrc, badge: tonBadgeSrc,
    desc: { ru: 'USDT в сети TON (Toncoin)\nУкажите адрес TON-кошелька', en: 'USDT on the TON network\nEnter your TON wallet address' } },
  { id: 'usdt-trc20', kind: 'crypto', chain: 'usdt-trc20', name: 'USDT', sub: 'TRC20',     sym: 'USDT', addr: 'tron', hero: smallUsdtSrc, art: usdtIconSrc, badge: trxBadgeSrc,
    desc: { ru: 'USDT в сети Tron (TRC20)\nУкажите адрес Tron-кошелька', en: 'USDT on Tron (TRC20)\nEnter your Tron wallet address' } },
  { id: 'trx',        kind: 'crypto', chain: 'trx',        name: 'TRX',  sub: 'Tron',      sym: 'TRX',  addr: 'tron', hero: smallTrxSrc,  art: trxIconSrc,  badge: null,
    desc: { ru: 'Сеть Tron\nУкажите адрес Tron-кошелька', en: 'Tron network\nEnter your Tron wallet address' } },
  { id: 'eth',        kind: 'crypto', chain: 'eth',        name: 'ETH',  sub: 'Ethereum',  sym: 'ETH',  addr: 'evm',  hero: smallEthSrc,  art: ethIconSrc,  badge: null,
    desc: { ru: 'Сеть Ethereum (ERC20)\nУкажите адрес ETH-кошелька (0x…)', en: 'Ethereum network (ERC20)\nEnter your ETH wallet address (0x…)' } },
  { id: 'usdt-erc20', kind: 'crypto', chain: 'usdt-erc20', name: 'USDT', sub: 'ERC20',     sym: 'USDT', addr: 'evm',  hero: smallUsdtSrc, art: usdtIconSrc, badge: ethBadgeSrc,
    desc: { ru: 'USDT в сети Ethereum (ERC20)\nУкажите адрес ERC20-кошелька (0x…)', en: 'USDT on Ethereum (ERC20)\nEnter your ERC20 wallet address (0x…)' } },
  { id: 'usdc-erc20', kind: 'crypto', chain: 'usdc-erc20', name: 'USDC', sub: 'ERC20',     sym: 'USDC', addr: 'evm',  hero: smallUsdcSrc, art: usdcIconSrc, badge: ethBadgeSrc,
    desc: { ru: 'USDC в сети Ethereum (ERC20)\nУкажите адрес ERC20-кошелька (0x…)', en: 'USDC on Ethereum (ERC20)\nEnter your ERC20 wallet address (0x…)' } },
  { id: 'usdc-bep20', kind: 'crypto', chain: 'usdc-bep20', name: 'USDC', sub: 'BEP20',     sym: 'USDC', addr: 'evm',  hero: smallUsdcSrc, art: usdcIconSrc, badge: bnbBadgeSrc,
    desc: { ru: 'USDC в сети BNB Smart Chain (BEP20)\nУкажите адрес BEP20-кошелька (0x…)', en: 'USDC on BNB Smart Chain (BEP20)\nEnter your BEP20 wallet address (0x…)' } },
]

function isValidTonAddress(addr) {
  if (!addr) return false
  const t = addr.trim()
  if (/^[UE]Q[A-Za-z0-9_-]{46}$/.test(t)) return true
  if (/^0:[a-fA-F0-9]{64}$/.test(t)) return true
  return false
}
function isValidEvmAddress(addr) {
  return /^0x[a-fA-F0-9]{40}$/.test((addr || '').trim())
}
function isValidTronAddress(addr) {
  return /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test((addr || '').trim())
}
function validateAddress(type, addr) {
  if (type === 'ton') return isValidTonAddress(addr)
  if (type === 'evm') return isValidEvmAddress(addr)
  if (type === 'tron') return isValidTronAddress(addr)
  return false
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

export default function WithdrawalSheet() {
  const { withdrawalOpen, setWithdrawalOpen, lang, currency, rates, balance, user, setBalance } = useGameStore()
  const t = translations[lang]

  const [view, setView] = useState('picker')   // 'picker' | coin.id
  const [wallet, setWallet] = useState('')
  const [memo, setMemo] = useState('')
  const [amount, setAmount] = useState('')
  const [status, setStatus] = useState('idle') // idle | loading | success | error
  const [errorMsg, setErrorMsg] = useState('')
  const [walletTouched, setWalletTouched] = useState(false)
  const [amountTouched, setAmountTouched] = useState(false)
  const [cfg, setCfg] = useState(null)         // per-chain { min, gas } RUB

  const coin = COINS.find(c => c.id === view) || null

  // Load per-chain crypto config once when the sheet opens.
  useEffect(() => {
    if (withdrawalOpen && !cfg) {
      getCryptoWithdrawCfg().then(c => setCfg(c || {})).catch(() => setCfg({}))
    }
  }, [withdrawalOpen, cfg])

  // Per-coin economics (min + gas in RUB).
  const isTonFamily = coin && (coin.kind === 'ton' || coin.kind === 'usdt-ton')
  const chainCfg = coin?.kind === 'crypto' ? (cfg?.[coin.chain] || null) : null
  const minRub = isTonFamily
    ? TON_MIN_RUB
    : (chainCfg ? Number(chainCfg.min) : null)
  const gasInRub = !coin
    ? 0
    : coin.kind === 'ton'
      ? GAS_TON * TON_RUB_PRICE
      : coin.kind === 'usdt-ton'
        ? GAS_RUB_USDT
        : (chainCfg ? Number(chainCfg.gas) : 0)

  const numAmount = Number(amount) || 0
  const amountInRub = currency.code === 'RUB'
    ? numAmount
    : (rates[currency.code] ? numAmount / rates[currency.code] : numAmount)

  const fee = Math.round(amountInRub * FEE_PERCENT)
  const totalFee = fee + Math.round(gasInRub)
  const netRub = amountInRub - totalFee
  const netDisplay = netRub > 0 ? netRub : 0

  const walletValid = coin ? validateAddress(coin.addr, wallet) : false
  const cfgReady = isTonFamily || (coin?.kind === 'crypto' && chainCfg != null)
  const amountValid = minRub != null && amountInRub >= minRub && amountInRub <= balance
  const canSubmit = !!coin && cfgReady && walletValid && amountValid && numAmount > 0

  const close = () => { haptic('light'); setWithdrawalOpen(false) }

  useEffect(() => {
    if (!withdrawalOpen) {
      setTimeout(() => {
        setView('picker'); setWallet(''); setMemo(''); setAmount('')
        setStatus('idle'); setErrorMsg('')
        setWalletTouched(false); setAmountTouched(false)
      }, 300)
    }
  }, [withdrawalOpen])

  // Telegram BackButton: detail → picker, picker → close.
  useEffect(() => {
    const tg = window.Telegram?.WebApp
    if (!tg) return
    if (withdrawalOpen) {
      tg.BackButton.show()
      const handler = () => {
        haptic('light')
        if (view !== 'picker') setView('picker')
        else close()
      }
      tg.BackButton.onClick(handler)
      return () => { tg.BackButton.offClick(handler) }
    } else {
      tg.BackButton.hide()
    }
  }, [withdrawalOpen, view])

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
    if (currency.code === 'RUB') setAmount(String(balance))
    else setAmount(convertFromRub(balance, currency.code, rates).toFixed(2))
    setAmountTouched(true)
  }

  async function handleSubmit() {
    if (!canSubmit || status === 'loading') return
    haptic('medium')
    setStatus('loading')
    setErrorMsg('')
    try {
      const amountRub = Math.round(amountInRub)
      let result
      if (coin.kind === 'ton') {
        result = await requestWithdrawal(user.id, amountRub, wallet.trim(), memo.trim())
      } else if (coin.kind === 'usdt-ton') {
        result = await requestUsdtWithdrawal(user.id, amountRub, wallet.trim(), memo.trim())
      } else {
        result = await requestCryptoWithdrawal(user.id, amountRub, coin.chain, wallet.trim())
      }

      if (result?.error) {
        setStatus('error')
        const errMap = {
          min_amount: t.withdrawMin?.replace('{amount}', fmtMin()) || 'Minimum not met',
          insufficient_balance: t.withdrawInsufficientBalance,
          user_not_found: 'User not found',
          bad_address: t.withdrawInvalidAddress,
          bad_chain: 'Unsupported network',
          amount_too_small_after_fees: lang === 'ru' ? 'Сумма слишком мала после вычета комиссии' : 'Amount too small after fees',
        }
        setErrorMsg(errMap[result.error] || result.error)
        return
      }
      if (result?.new_balance != null) setBalance(result.new_balance)
      setStatus('success')
      try { window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred('success') } catch { /* noop */ }
    } catch (err) {
      console.error('Withdrawal error:', err)
      setStatus('error')
      setErrorMsg(lang === 'ru' ? 'Ошибка при создании заявки' : 'Failed to create withdrawal')
    }
  }

  function fmtMin() { return minRub != null ? formatCurrency(minRub, currency, rates) : '—' }
  function fmtMax() { return formatCurrency(balance, currency, rates) }
  function fmtTotalFee() { return formatCurrency(totalFee, currency, rates) }
  function fmtReceive() { return formatCurrency(netDisplay, currency, rates) }

  const showWalletError = walletTouched && wallet.length > 0 && !walletValid
  const showAmountError = amountTouched && numAmount > 0 && !amountValid

  return (
    <>
      <div className={`wd-overlay ${withdrawalOpen ? 'visible' : ''}`} onClick={close} />

      <div className={`wd-sheet ${withdrawalOpen ? 'open' : ''}`}>
        <div className="wd-handle" />

        {status === 'success' && (
          <div className="wd-success">
            <SuccessCheckmark />
            <span className="wd-success-title">{t.withdrawSuccess}</span>
            <span className="wd-success-sub">{t.withdrawSuccessSub}</span>
          </div>
        )}

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

        {/* Coin picker */}
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
                {COINS.map(c => (
                  <button
                    key={c.id}
                    type="button"
                    className={`deposit-coin-card ${c.sym === 'TON' ? 'deposit-coin-card--ton' : 'deposit-coin-card--usdt'}`}
                    onClick={() => { haptic('medium'); setView(c.id); setWallet(''); setMemo(''); setAmount(''); setWalletTouched(false); setAmountTouched(false) }}
                  >
                    {c.badge && (
                      <img className="deposit-coin-card-net-badge" src={c.badge} alt="" draggable="false" />
                    )}
                    <div className="deposit-coin-card-text">
                      <span className="deposit-coin-card-name">{c.name}</span>
                      <span className="deposit-coin-card-sub">{c.sub}</span>
                    </div>
                    <img className="deposit-coin-card-art" src={c.art} alt="" draggable="false" />
                  </button>
                ))}
              </div>
            </div>
          </>
        )}

        {/* Detail form — one generic view for every coin */}
        {(status === 'idle' || status === 'loading') && coin && (
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
              <div className="wd-ton-banner">
                <div className="wd-ton-icon">
                  <img src={coin.hero} width={56} height={56} alt="" draggable="false" />
                </div>
                <div className="wd-ton-text">
                  <span className="wd-ton-title">{coin.name} <span style={{ opacity: 0.5, fontWeight: 500 }}>· {coin.sub}</span></span>
                  <span className="wd-ton-desc">{coin.desc?.[lang] || coin.desc?.en}</span>
                </div>
              </div>

              {/* Wallet address */}
              <div className="wd-field">
                <label className="wd-label">{t.withdrawWallet}</label>
                <div className={`wd-input-wrap ${showWalletError ? 'error' : wallet && walletValid ? 'valid' : ''}`}>
                  <input
                    className="wd-input"
                    type="text"
                    placeholder={ADDR_PH[coin.addr] || t.withdrawWalletPlaceholder}
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

              {/* Memo — TON family only (USDT/TON deposits use memo) */}
              {isTonFamily && (
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
              )}

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
                {!cfgReady && coin.kind === 'crypto' && (
                  <span className="wd-field-error" style={{ color: 'var(--text-muted)' }}>
                    {lang === 'ru' ? 'Загрузка лимитов…' : 'Loading limits…'}
                  </span>
                )}
                {showAmountError && minRub != null && amountInRub < minRub && (
                  <span className="wd-field-error">{t.withdrawMin.replace('{amount}', fmtMin())}</span>
                )}
                {showAmountError && amountInRub > balance && (
                  <span className="wd-field-error">{t.withdrawInsufficientBalance}</span>
                )}
              </div>

              {/* Fee breakdown */}
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

              <button
                className="wd-submit-btn"
                disabled={!canSubmit || status === 'loading'}
                onClick={handleSubmit}
              >
                {status === 'loading' ? (
                  <div className="wd-btn-spinner" />
                ) : (
                  <>{t.withdrawBtn} <img src={coin.hero} width={18} height={18} alt="" draggable="false" style={{ verticalAlign: 'middle' }} /></>
                )}
              </button>
            </div>
          </>
        )}
      </div>
    </>
  )
}

/**
 * Withdrawal queue processor
 * Picks pending withdrawals one by one and sends TON from hot wallet.
 * TON uses seqno — only one tx at a time, hence sequential processing.
 */

import { Router } from 'express'
import { createClient } from '@supabase/supabase-js'
import { sendTon, getWalletBalance } from '../lib/ton-wallet.js'
import { getCryptoPrices } from '../lib/prices.js'

const router = Router()

// Supabase admin client (service role for RPCs)
const supabase = createClient(
  process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY,
)

// USD → RUB rate (cached 5 min)
let rubRateCache = { rate: 90, fetchedAt: 0 }
const RUB_RATE_TTL = 300_000

async function getUsdRubRate() {
  if (Date.now() - rubRateCache.fetchedAt < RUB_RATE_TTL) {
    return rubRateCache.rate
  }
  try {
    const res = await fetch('https://api.exchangerate-api.com/v4/latest/USD')
    if (!res.ok) return rubRateCache.rate || 90
    const data = await res.json()
    const rate = data?.rates?.RUB ?? 90
    rubRateCache = { rate, fetchedAt: Date.now() }
    return rate
  } catch {
    return rubRateCache.rate || 90
  }
}

// Track processing state
let isProcessing = false
let lastProcessedAt = null
let processedCount = 0
let failedCount = 0

/**
 * Process one pending withdrawal from the queue
 */
async function processOne() {
  if (isProcessing) return { skipped: true, reason: 'already_processing' }
  isProcessing = true

  try {
    // 1. Pick oldest pending withdrawal (FOR UPDATE SKIP LOCKED)
    const { data: rows, error: pickErr } = await supabase.rpc('pick_pending_withdrawal')

    if (pickErr) {
      console.error('[withdrawals] pick error:', pickErr.message)
      return { error: pickErr.message }
    }

    // pick_pending_withdrawal returns null/empty if none pending
    const wd = Array.isArray(rows) ? rows[0] : rows
    if (!wd) return { idle: true }

    console.log(`[withdrawals] Processing #${wd.id}: ${wd.net_rub} RUB → ${wd.ton_address}`)

    // 2. Convert net_rub → TON
    const [prices, rubRate] = await Promise.all([getCryptoPrices(), getUsdRubRate()])
    const tonPriceUsd = prices.ton
    const tonPriceRub = tonPriceUsd * rubRate

    if (!tonPriceRub || tonPriceRub <= 0) {
      // Can't get price — fail & refund
      await supabase.rpc('fail_withdrawal', {
        p_withdrawal_id: wd.id,
        p_error: 'Could not fetch TON price',
      })
      failedCount++
      console.error('[withdrawals] Failed: could not fetch TON price')
      return { failed: true, reason: 'price_unavailable' }
    }

    const tonAmount = wd.net_rub / tonPriceRub
    const tonRounded = Math.floor(tonAmount * 1e9) / 1e9 // 9 decimal places

    if (tonRounded <= 0.001) {
      await supabase.rpc('fail_withdrawal', {
        p_withdrawal_id: wd.id,
        p_error: `TON amount too small: ${tonRounded}`,
      })
      failedCount++
      return { failed: true, reason: 'ton_amount_too_small' }
    }

    // 3. Check hot wallet has enough balance
    const walletBalance = await getWalletBalance()
    if (walletBalance < tonRounded + 0.05) { // 0.05 TON safety margin for gas
      await supabase.rpc('fail_withdrawal', {
        p_withdrawal_id: wd.id,
        p_error: `Hot wallet balance too low: ${walletBalance.toFixed(4)} TON`,
      })
      failedCount++
      console.error(`[withdrawals] Failed: wallet balance ${walletBalance} < needed ${tonRounded + 0.05}`)
      return { failed: true, reason: 'wallet_low_balance' }
    }

    // 4. Send TON
    console.log(`[withdrawals] Sending ${tonRounded} TON (${wd.net_rub} RUB @ ${tonPriceRub.toFixed(2)} RUB/TON)`)
    const result = await sendTon(wd.ton_address, tonRounded, wd.memo || '')

    // 5. Mark completed
    // tx_hash: we don't have the actual hash from seqno-based send, use seqno as reference
    const txRef = `seqno:${result.seqno}`
    await supabase.rpc('complete_withdrawal', {
      p_withdrawal_id: wd.id,
      p_tx_hash: txRef,
      p_ton_amount: tonRounded,
    })

    processedCount++
    lastProcessedAt = new Date().toISOString()
    console.log(`[withdrawals] Completed #${wd.id}: ${tonRounded} TON sent`)

    return { completed: true, withdrawal_id: wd.id, ton_amount: tonRounded }

  } catch (err) {
    console.error('[withdrawals] Process error:', err.message)

    // Try to fail the withdrawal if we know which one we were processing
    try {
      // We need to find any 'processing' withdrawal and fail it
      const { data: processing } = await supabase
        .from('withdrawals')
        .select('id')
        .eq('status', 'processing')
        .limit(1)
        .single()

      if (processing) {
        await supabase.rpc('fail_withdrawal', {
          p_withdrawal_id: processing.id,
          p_error: err.message,
        })
        failedCount++
      }
    } catch (refundErr) {
      console.error('[withdrawals] Refund error:', refundErr.message)
    }

    return { error: err.message }
  } finally {
    isProcessing = false
  }
}

// ── Routes ──

// Process one withdrawal (admin-authed, also called by auto-processor)
router.get('/process', async (_req, res) => {
  const result = await processOne()
  res.json(result)
})

// Queue status
router.get('/status', async (_req, res) => {
  const { data: pending } = await supabase
    .from('withdrawals')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'pending')

  const { count: pendingCount } = await supabase
    .from('withdrawals')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'pending')

  res.json({
    isProcessing,
    pendingCount: pendingCount ?? 0,
    processedCount,
    failedCount,
    lastProcessedAt,
  })
})

// Recent withdrawals (for admin)
router.get('/recent', async (_req, res) => {
  const { data, error } = await supabase
    .from('withdrawals')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(20)

  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

export default router
export { processOne }

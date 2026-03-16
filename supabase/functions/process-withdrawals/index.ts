/**
 * process-withdrawals — Supabase Edge Function
 * Loops through ALL pending withdrawals, processing one at a time.
 * Called by pg_cron every minute + frontend ping after each request.
 *
 * TON wallets use seqno (sequential nonce) — only one tx at a time.
 * The SQL function pick_pending_withdrawal() guards against concurrent
 * execution: if any withdrawal is 'processing', it returns nothing.
 * Stuck withdrawals (>5 min) are auto-failed and refunded.
 *
 * Wall-clock limit: 50s (Edge Function timeout = 60s, leave 10s margin).
 * Each TON send takes ~10-30s, so we process 2-4 withdrawals per call.
 */

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// @ton/* — use npm: specifiers (Deno supports npm packages)
// Import Address and toNano from @ton/ton (re-exports from @ton/core)
// to avoid version mismatch between separate @ton/core import
import { TonClient, WalletContractV4, internal, Address, toNano } from 'npm:@ton/ton@15'
import { mnemonicToPrivateKey } from 'npm:@ton/crypto@3'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const WALLET_TON_MNEMONIC = Deno.env.get('WALLET_TON_MNEMONIC')!
const TONCENTER_API_KEY = Deno.env.get('TONCENTER_API_KEY') || undefined

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const TONCENTER_ENDPOINT = 'https://toncenter.com/api/v2/jsonRPC'
const CONFIRMATION_TIMEOUT_MS = 45_000 // 45s per tx (leave room for loop overhead)
const POLL_INTERVAL_MS = 2_000
const WALL_CLOCK_LIMIT_MS = 50_000 // stop picking new work after 50s

let supabase: ReturnType<typeof createClient>
function getSupabase() {
  if (!supabase) supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
  return supabase
}

async function logToAdmin(level: string, message: string, details: Record<string, unknown> = {}) {
  try {
    await getSupabase().rpc('admin_log', {
      p_level: level,
      p_source: 'edge:process-withdrawals',
      p_message: message,
      p_details: details,
    })
  } catch (e) {
    console.error('Failed to write admin log:', e)
  }
}

// ── Fetch with retry ──

async function fetchWithRetry(url: string, retries = 3, delayMs = 500): Promise<Response> {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url)
      if (res.ok || res.status < 500) return res
      console.warn(`Fetch ${url} returned ${res.status}, retry ${i + 1}/${retries}`)
    } catch (e) {
      if (i === retries - 1) throw e
      console.warn(`Fetch ${url} failed, retry ${i + 1}/${retries}:`, (e as Error).message)
    }
    await new Promise(r => setTimeout(r, delayMs * (i + 1)))
  }
  throw new Error(`Failed to fetch ${url} after ${retries} retries`)
}

// ── Price helpers (fetched once per invocation, reused in loop) ──

async function getUsdRubRate(): Promise<number> {
  try {
    const res = await fetchWithRetry('https://api.exchangerate-api.com/v4/latest/USD')
    if (!res.ok) return 90
    const data = await res.json()
    return data?.rates?.RUB ?? 90
  } catch {
    return 90
  }
}

async function getTonPriceRub(): Promise<number> {
  try {
    const res = await fetchWithRetry('https://api.coinlore.net/api/ticker/?id=54683')
    if (!res.ok) return 0
    const data = await res.json()
    const usdPrice = parseFloat(data?.[0]?.price_usd)
    if (!usdPrice || usdPrice <= 0) return 0
    const rubRate = await getUsdRubRate()
    return usdPrice * rubRate
  } catch {
    return 0
  }
}

// ── TON wallet ──

function getTonClient() {
  return new TonClient({
    endpoint: TONCENTER_ENDPOINT,
    apiKey: TONCENTER_API_KEY,
  })
}

async function getWalletBalance(): Promise<number> {
  if (!WALLET_TON_MNEMONIC) return 0
  const keyPair = await mnemonicToPrivateKey(WALLET_TON_MNEMONIC.split(' '))
  const wallet = WalletContractV4.create({ workchain: 0, publicKey: keyPair.publicKey })
  const client = getTonClient()
  const balance = await client.getBalance(wallet.address)
  return Number(balance) / 1e9
}

async function sendTon(toAddress: string, amountTon: number, memo = ''): Promise<{ success: true; seqno: number }> {
  if (!WALLET_TON_MNEMONIC) throw new Error('WALLET_TON_MNEMONIC not configured')

  const keyPair = await mnemonicToPrivateKey(WALLET_TON_MNEMONIC.split(' '))
  const wallet = WalletContractV4.create({ workchain: 0, publicKey: keyPair.publicKey })
  const client = getTonClient()
  const contract = client.open(wallet)

  // Parse and re-stringify address to normalize format
  const dest = Address.parse(toAddress)
  const destStr = dest.toString({ bounceable: true })
  console.log(`[ton] Destination: ${destStr}`)

  const seqno = await contract.getSeqno()

  await contract.sendTransfer({
    seqno,
    secretKey: keyPair.secretKey,
    messages: [
      internal({
        to: destStr,
        value: toNano(amountTon.toFixed(9)),
        body: memo || undefined,
      }),
    ],
  })

  console.log(`[ton] Transfer sent: ${amountTon} TON → ${toAddress} (seqno ${seqno})`)

  // Wait for seqno increment (confirmation)
  const deadline = Date.now() + CONFIRMATION_TIMEOUT_MS
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS))
    try {
      const newSeqno = await contract.getSeqno()
      if (newSeqno > seqno) {
        console.log(`[ton] Confirmed: seqno ${seqno} → ${newSeqno}`)
        return { success: true, seqno: newSeqno }
      }
    } catch (e) {
      console.warn('[ton] Poll error:', (e as Error).message)
    }
  }
  throw new Error(`Transaction not confirmed after ${CONFIRMATION_TIMEOUT_MS / 1000}s`)
}

// ── Process single withdrawal ──

interface ProcessResult {
  completed?: boolean
  failed?: boolean
  skipped?: boolean
  withdrawal_id?: string
  ton_amount?: number
  reason?: string
  error?: string
}

async function processOne(sb: ReturnType<typeof createClient>, tonPriceRub: number): Promise<ProcessResult> {
  // Pick next pending (SQL guards against concurrent execution)
  const { data: rows, error: pickErr } = await sb.rpc('pick_pending_withdrawal')

  if (pickErr) {
    console.error('Pick error:', pickErr.message)
    return { error: pickErr.message }
  }

  const wd = Array.isArray(rows) ? rows[0] : rows
  if (!wd) return { skipped: true, reason: 'empty_queue' }

  console.log(`Processing #${wd.id}: ${wd.net_rub} RUB → ${wd.ton_address}`)

  // Convert net_rub → TON
  const tonAmount = wd.net_rub / tonPriceRub
  const tonRounded = Math.floor(tonAmount * 1e9) / 1e9

  if (tonRounded <= 0.001) {
    await sb.rpc('fail_withdrawal', { p_withdrawal_id: wd.id, p_error: `TON amount too small: ${tonRounded}` })
    return { failed: true, withdrawal_id: wd.id, reason: 'ton_amount_too_small' }
  }

  // Check hot wallet balance
  const walletBalance = await getWalletBalance()
  if (walletBalance < tonRounded + 0.05) {
    await sb.rpc('fail_withdrawal', {
      p_withdrawal_id: wd.id,
      p_error: `Hot wallet balance too low: ${walletBalance.toFixed(4)} TON`,
    })
    await logToAdmin('error', 'Wallet balance low', { wallet_balance: walletBalance, needed: tonRounded + 0.05 })
    return { failed: true, withdrawal_id: wd.id, reason: 'wallet_low_balance' }
  }

  // Send TON
  console.log(`Sending ${tonRounded} TON (${wd.net_rub} RUB @ ${tonPriceRub.toFixed(2)} RUB/TON)`)
  const result = await sendTon(wd.ton_address, tonRounded, wd.memo || '')

  // Mark completed
  const txRef = `seqno:${result.seqno}`
  await sb.rpc('complete_withdrawal', {
    p_withdrawal_id: wd.id,
    p_tx_hash: txRef,
    p_ton_amount: tonRounded,
  })

  console.log(`Completed #${wd.id}: ${tonRounded} TON`)
  return { completed: true, withdrawal_id: wd.id, ton_amount: tonRounded }
}

// ── Main: loop until queue empty or wall-clock limit ──

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  const startTime = Date.now()

  try {
    if (!WALLET_TON_MNEMONIC) {
      return jsonResponse({ error: 'WALLET_TON_MNEMONIC not configured' }, 500)
    }

    const sb = getSupabase()

    // Fetch TON price once (reuse for all withdrawals in this batch)
    const tonPriceRub = await getTonPriceRub()
    if (!tonPriceRub || tonPriceRub <= 0) {
      await logToAdmin('error', 'Cannot fetch TON price, skipping run')
      return jsonResponse({ error: 'price_unavailable' })
    }

    const results: ProcessResult[] = []
    let completed = 0
    let failed = 0

    // Loop: process withdrawals one by one until queue empty or time limit
    while (Date.now() - startTime < WALL_CLOCK_LIMIT_MS) {
      try {
        const result = await processOne(sb, tonPriceRub)

        if (result.skipped) break // queue empty
        if (result.error) { failed++; break } // DB error, stop

        results.push(result)
        if (result.completed) completed++
        if (result.failed) failed++

        // Small pause between sends to let seqno settle
        await new Promise(r => setTimeout(r, 500))

      } catch (err) {
        console.error('Process error in loop:', err)

        // Try to fail the current 'processing' withdrawal
        try {
          const { data: stuck } = await sb
            .from('withdrawals')
            .select('id')
            .eq('status', 'processing')
            .limit(1)
            .single()

          if (stuck) {
            await sb.rpc('fail_withdrawal', {
              p_withdrawal_id: stuck.id,
              p_error: (err as Error).message,
            })
            failed++
            console.log(`Refunded stuck withdrawal ${stuck.id}`)
          }
        } catch (refundErr) {
          console.error('Refund error:', refundErr)
        }

        // Don't continue loop after a send error — seqno might be in bad state
        break
      }
    }

    const elapsed = Date.now() - startTime
    const summary = { completed, failed, total: results.length, ton_price_rub: tonPriceRub, elapsed_ms: elapsed }
    console.log('Batch summary:', JSON.stringify(summary))

    if (completed > 0 || failed > 0) {
      await logToAdmin('info', `Withdrawal batch: ${completed} ok, ${failed} failed`, summary)
    }

    return jsonResponse(summary)

  } catch (err) {
    console.error('Fatal error:', err)
    await logToAdmin('error', 'process-withdrawals fatal: ' + (err as Error).message, {
      stack: (err as Error).stack,
    })
    return jsonResponse({ error: (err as Error).message }, 500)
  }
})

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

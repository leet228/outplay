/**
 * process-withdrawals — Supabase Edge Function
 * Uses Highload Wallet V3 to batch-send ALL pending withdrawals in one tx.
 * Called by pg_cron every minute + frontend ping after each request.
 *
 * Highload V3 can send up to 254 messages in a single transaction,
 * eliminating the sequential seqno bottleneck of WalletContractV4.
 */

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// All @ton packages pinned to compatible versions (core@0.56.3)
import { TonClient } from 'npm:@ton/ton@13'
import { Address, toNano, internal, SendMode } from 'npm:@ton/core@0.56.3'
import { mnemonicToPrivateKey } from 'npm:@ton/crypto@3'
import { HighloadWalletV3 } from 'npm:@tonkite/highload-wallet-v3@3'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const WALLET_TON_MNEMONIC = Deno.env.get('WALLET_TON_MNEMONIC')!
const TONCENTER_API_KEY = Deno.env.get('TONCENTER_API_KEY') || undefined
const WALLET_ADDRESS = 'UQDsqlvskoZupLe-DFTwffYIqMIXxq6ghYSqh_PjIfOHz_bC'

// Persist query ID sequence value across invocations (in-memory)
let queryIdValue: bigint | null = null

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const TONCENTER_ENDPOINT = 'https://toncenter.com/api/v2/jsonRPC'
const MAX_BATCH_SIZE = 200
const WALL_CLOCK_LIMIT_MS = 50_000

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

// ── Price helpers ──

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

// ── TON Highload V3 wallet ──

function getTonClient() {
  return new TonClient({
    endpoint: TONCENTER_ENDPOINT,
    apiKey: TONCENTER_API_KEY,
  })
}

async function getKeyPair() {
  return await mnemonicToPrivateKey(WALLET_TON_MNEMONIC.split(' '))
}

async function getWalletBalance(): Promise<number> {
  const client = getTonClient()
  const balance = await client.getBalance(Address.parse(WALLET_ADDRESS))
  return Number(balance) / 1e9
}

interface WithdrawalItem {
  address: string
  amountTon: number
  memo: string
  id: string
}

async function sendBatchTon(withdrawals: WithdrawalItem[]): Promise<{ success: true }> {
  if (!WALLET_TON_MNEMONIC) throw new Error('WALLET_TON_MNEMONIC not configured')
  if (withdrawals.length === 0) throw new Error('Empty batch')

  const keyPair = await getKeyPair()
  const client = getTonClient()

  // Restore or create query ID sequence
  const queryIdSequence = queryIdValue !== null
    ? HighloadWalletV3.restoreSequence(queryIdValue)
    : HighloadWalletV3.newSequence()

  const wallet = client.open(new HighloadWalletV3(queryIdSequence, keyPair.publicKey))

  const messages = withdrawals.map(wd => ({
    mode: SendMode.PAY_GAS_SEPARATELY as number,
    message: internal({
      to: Address.parse(wd.address),
      value: toNano(wd.amountTon.toFixed(9)),
      body: wd.memo || undefined,
    }),
  }))

  console.log(`[highload-v3] Sending batch of ${messages.length} transfers`)
  await wallet.sendBatch(keyPair.secretKey, { messages })

  // Save query ID for next invocation
  queryIdValue = queryIdSequence.current()
  console.log(`[highload-v3] Batch sent successfully`)
  return { success: true }
}

// ── Main ──

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  const startTime = Date.now()

  try {
    if (!WALLET_TON_MNEMONIC) {
      return jsonResponse({ error: 'WALLET_TON_MNEMONIC not configured' }, 500)
    }

    const sb = getSupabase()

    // Auto-fail stuck 'processing' withdrawals (> 5 min)
    await sb.rpc('cleanup_stuck_withdrawals')

    // Fetch TON price once
    const tonPriceRub = await getTonPriceRub()
    if (!tonPriceRub || tonPriceRub <= 0) {
      await logToAdmin('error', 'Cannot fetch TON price, skipping run')
      return jsonResponse({ error: 'price_unavailable' })
    }

    // Check if any withdrawal is already processing
    const { count: processingCount } = await sb
      .from('withdrawals')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'processing')

    if (processingCount && processingCount > 0) {
      return jsonResponse({ completed: 0, failed: 0, reason: 'worker_active', ton_price_rub: tonPriceRub })
    }

    // Pick ALL pending withdrawals
    const { data: pending, error: pickErr } = await sb
      .from('withdrawals')
      .select('id, user_id, net_rub, ton_amount, ton_address, memo')
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .limit(MAX_BATCH_SIZE)

    if (pickErr) {
      console.error('Pick error:', pickErr.message)
      return jsonResponse({ error: pickErr.message })
    }

    if (!pending || pending.length === 0) {
      return jsonResponse({ completed: 0, failed: 0, reason: 'empty_queue', ton_price_rub: tonPriceRub })
    }

    // Mark all as 'processing'
    const ids = pending.map((w: { id: string }) => w.id)
    await sb.from('withdrawals').update({ status: 'processing' }).in('id', ids)

    console.log(`Processing batch of ${pending.length} withdrawals`)

    // Calculate TON amounts and validate
    const validWithdrawals: WithdrawalItem[] = []
    const failedIds: string[] = []

    for (const wd of pending) {
      let tonRounded: number

      if (wd.ton_amount && Number(wd.ton_amount) > 0) {
        tonRounded = Math.floor(Number(wd.ton_amount) * 1e9) / 1e9
      } else {
        tonRounded = Math.floor((wd.net_rub / tonPriceRub) * 1e9) / 1e9
      }

      if (tonRounded <= 0.001) {
        await sb.rpc('fail_withdrawal', { p_withdrawal_id: wd.id, p_error: `TON amount too small: ${tonRounded}` })
        failedIds.push(wd.id)
        continue
      }

      validWithdrawals.push({ address: wd.ton_address, amountTon: tonRounded, memo: wd.memo || '', id: wd.id })
    }

    if (validWithdrawals.length === 0) {
      return jsonResponse({ completed: 0, failed: failedIds.length, ton_price_rub: tonPriceRub })
    }

    // Check wallet balance
    const totalTon = validWithdrawals.reduce((sum, w) => sum + w.amountTon, 0)
    const walletBalance = await getWalletBalance()
    const gasReserve = 0.1 + validWithdrawals.length * 0.01

    if (walletBalance < totalTon + gasReserve) {
      for (const wd of validWithdrawals) {
        await sb.rpc('fail_withdrawal', {
          p_withdrawal_id: wd.id,
          p_error: `Wallet balance too low: ${walletBalance.toFixed(4)} TON`,
        })
        failedIds.push(wd.id)
      }
      await logToAdmin('error', 'Wallet balance too low for batch', { wallet_balance: walletBalance, needed: totalTon + gasReserve })
      return jsonResponse({ completed: 0, failed: failedIds.length, reason: 'wallet_low_balance', ton_price_rub: tonPriceRub })
    }

    // Send batch via Highload V3
    try {
      await sendBatchTon(validWithdrawals)

      // Mark all completed
      const txRef = `highload-${Date.now()}`
      for (const wd of validWithdrawals) {
        await sb.rpc('complete_withdrawal', { p_withdrawal_id: wd.id, p_tx_hash: txRef, p_ton_amount: wd.amountTon })
      }

      const elapsed = Date.now() - startTime
      const summary = { completed: validWithdrawals.length, failed: failedIds.length, total_ton: totalTon, ton_price_rub: tonPriceRub, elapsed_ms: elapsed, batch_mode: 'highload-v3' }
      console.log('Batch summary:', JSON.stringify(summary))
      await logToAdmin('info', `Withdrawal batch: ${validWithdrawals.length} ok, ${failedIds.length} failed`, summary)
      return jsonResponse(summary)

    } catch (sendErr) {
      console.error('Batch send error:', sendErr)
      for (const wd of validWithdrawals) {
        try {
          await sb.rpc('fail_withdrawal', { p_withdrawal_id: wd.id, p_error: (sendErr as Error).message })
          failedIds.push(wd.id)
        } catch (e) {
          console.error(`Refund error for ${wd.id}:`, e)
        }
      }
      await logToAdmin('error', 'Highload batch send failed', { error: (sendErr as Error).message, batch_size: validWithdrawals.length })
      return jsonResponse({ completed: 0, failed: failedIds.length, error: (sendErr as Error).message, ton_price_rub: tonPriceRub })
    }

  } catch (err) {
    console.error('Fatal error:', err)
    await logToAdmin('error', 'process-withdrawals fatal: ' + (err as Error).message, { stack: (err as Error).stack })
    return jsonResponse({ error: (err as Error).message }, 500)
  }
})

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

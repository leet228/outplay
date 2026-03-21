/**
 * process-withdrawals — Supabase Edge Function
 * Uses Highload Wallet V3 to batch-send ALL pending withdrawals in one tx.
 *
 * Official contract code from ton-blockchain/highload-wallet-contract-v3
 * No external tonkite dependency — uses @ton/ton + @ton/core + @ton/crypto only.
 *
 * Called by pg_cron every minute + frontend ping after each request.
 */

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import {
  TonClient,
  Address, toNano, Cell, beginCell,
  SendMode, contractAddress, StateInit,
} from 'npm:@ton/ton@15'
import { mnemonicToPrivateKey, sign } from 'npm:@ton/crypto@3'

// ── Highload Wallet V3 official contract code ──
const HIGHLOAD_V3_CODE_HEX = 'b5ee9c7241021001000228000114ff00f4a413f4bcf2c80b01020120020d02014803040078d020d74bc00101c060b0915be101d0d3030171b0915be0fa4030f828c705b39130e0d31f018210ae42e5a4ba9d8040d721d74cf82a01ed55fb04e030020120050a02027306070011adce76a2686b85ffc00201200809001aabb6ed44d0810122d721d70b3f0018aa3bed44d08307d721d70b1f0201200b0c001bb9a6eed44d0810162d721d70b15800e5b8bf2eda2edfb21ab09028409b0ed44d0810120d721f404f404d33fd315d1058e1bf82325a15210b99f326df82305aa0015a112b992306dde923033e2923033e25230800df40f6fa19ed021d721d70a00955f037fdb31e09130e259800df40f6fa19cd001d721d70a00937fdb31e0915be270801f6f2d48308d718d121f900ed44d0d3ffd31ff404f404d33fd315d1f82321a15220b98e12336df82324aa00a112b9926d32de58f82301de541675f910f2a106d0d31fd4d307d30cd309d33fd315d15168baf2a2515abaf2a6f8232aa15250bcf2a304f823bbf2a35304800df40f6fa199d024d721d70a00f2649130e20e01fe5309800df40f6fa18e13d05004d718d20001f264c858cf16cf8301cf168e1030c824cf40cf8384095005a1a514cf40e2f800c94039800df41704c8cbff13cb1ff40012f40012cb3f12cb15c9ed54f80f21d0d30001f265d3020171b0925f03e0fa4001d70b01c000f2a5fa4031fa0031f401fa0031fa00318060d721d300010f0020f265d2000193d431d19130e272b1fb00b585bf03'

const SUBWALLET_ID = 0x10ad
const TIMEOUT = 60 * 60 * 24 // 86400s — must match tonkite defaults for same address

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const WALLET_TON_MNEMONIC = Deno.env.get('WALLET_TON_MNEMONIC')!
const TONCENTER_API_KEY = Deno.env.get('TONCENTER_API_KEY') || undefined

// Query ID tracking (persisted in-memory per Edge Function instance)
// Start from random shift to avoid conflicts with previously used query IDs
let queryShift = Math.floor(Math.random() * 4000) + 100
let queryBitNumber = 0

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
    } catch (e) {
      if (i === retries - 1) throw e
    }
    await new Promise(r => setTimeout(r, delayMs * (i + 1)))
  }
  throw new Error(`Failed to fetch after ${retries} retries`)
}

// ── Price helpers ──

async function getUsdRubRate(): Promise<number> {
  try {
    const res = await fetchWithRetry('https://api.exchangerate-api.com/v4/latest/USD')
    if (!res.ok) return 90
    const data = await res.json()
    return data?.rates?.RUB ?? 90
  } catch { return 90 }
}

async function getTonPriceRub(): Promise<number> {
  try {
    const res = await fetchWithRetry('https://api.coinlore.net/api/ticker/?id=54683')
    if (!res.ok) return 0
    const data = await res.json()
    const usdPrice = parseFloat(data?.[0]?.price_usd)
    if (!usdPrice || usdPrice <= 0) return 0
    return usdPrice * await getUsdRubRate()
  } catch { return 0 }
}

// ── Helpers ──

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substr(i, 2), 16)
  }
  return bytes
}

// ── Highload Wallet V3 implementation ──

function getHighloadCode(): Cell {
  return Cell.fromBoc(hexToBytes(HIGHLOAD_V3_CODE_HEX))[0]
}

function buildInitData(publicKey: Uint8Array): Cell {
  return beginCell()
    .storeBuffer(publicKey, 32)
    .storeUint(SUBWALLET_ID, 32)
    .storeUint(0, 1) // old queries (empty dict)
    .storeUint(0, 1) // current queries (empty dict)
    .storeUint(0, 64) // last_cleaned
    .storeUint(TIMEOUT, 22)
    .endCell()
}

function getWalletAddress(publicKey: Uint8Array): Address {
  const code = getHighloadCode()
  const data = buildInitData(publicKey)
  return contractAddress(0, { code, data })
}

function getWalletStateInit(publicKey: Uint8Array): StateInit {
  return { code: getHighloadCode(), data: buildInitData(publicKey) }
}

function nextQueryId(): { shift: number; bitNumber: number } {
  const result = { shift: queryShift, bitNumber: queryBitNumber }
  queryBitNumber++
  if (queryBitNumber >= 1023) {
    queryBitNumber = 0
    queryShift++
    if (queryShift >= 8191) queryShift = 0
  }
  return result
}

function packActions(messages: { mode: number; outMsg: Cell }[]): Cell {
  // Pack messages into action list (right to left)
  let actionList = beginCell().endCell()
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    actionList = beginCell()
      .storeRef(actionList)
      .storeUint(0x0ec3c86d, 32) // action_send_msg
      .storeUint(msg.mode, 8)
      .storeRef(msg.outMsg)
      .endCell()
  }
  return actionList
}

async function sendBatch(
  client: TonClient,
  secretKey: Uint8Array,
  publicKey: Uint8Array,
  messages: { to: Address; value: bigint; body?: string }[]
): Promise<void> {
  const walletAddress = getWalletAddress(publicKey)
  const stateInit = getWalletStateInit(publicKey)

  // Check if contract is deployed
  const contractState = await client.getContractState(walletAddress)
  const isDeployed = contractState.state === 'active'

  // Build internal messages manually (no `internal()` — avoid serialization issues in Deno)
  const outMsgs = messages.map(msg => {
    const msgCell = beginCell()
      .storeUint(0x10, 6)        // internal message, no bounce
      .storeAddress(msg.to)       // dest
      .storeCoins(msg.value)      // value
      .storeUint(0, 1 + 4 + 4 + 64 + 32 + 1 + 1) // no extra, no state init, no body
      .endCell()
    return { mode: SendMode.PAY_GAS_SEPARATELY, outMsg: msgCell }
  })

  const actionList = packActions(outMsgs)
  const qid = nextQueryId()
  const queryId = BigInt(qid.shift) * 1024n + BigInt(qid.bitNumber)
  const createdAt = Math.floor(Date.now() / 1000) - 10 // small offset to ensure validity

  // Build signing message
  const signingMessage = beginCell()
    .storeUint(SUBWALLET_ID, 32)
    .storeRef(actionList)
    .storeUint(SendMode.PAY_GAS_SEPARATELY, 8)
    .storeUint(queryId, 23) // shift(13) + bitNumber(10)
    .storeUint(createdAt, 64)
    .storeUint(TIMEOUT, 22)
    .endCell()

  const signature = sign(signingMessage.hash(), secretKey)

  const body = beginCell()
    .storeBuffer(signature, 64)
    .storeRef(signingMessage)
    .endCell()

  // Build external message
  const ext = beginCell()
    .storeUint(0b10, 2) // ext_in_msg_info
    .storeUint(0, 2)    // src: addr_none
    .storeAddress(walletAddress) // dest
    .storeCoins(0)       // import_fee
    .storeBit(isDeployed ? false : true) // state_init present?

  if (!isDeployed) {
    // Include state init for deployment
    ext.storeBit(true) // state init as ref
    ext.storeRef(
      beginCell()
        .storeBit(false) // split_depth
        .storeBit(false) // special
        .storeBit(true)  // code present
        .storeRef(stateInit.code!)
        .storeBit(true)  // data present
        .storeRef(stateInit.data!)
        .storeBit(false) // library
        .endCell()
    )
  }

  ext.storeBit(true) // body as ref
  ext.storeRef(body)

  const extMsg = ext.endCell()

  // Send via TonCenter
  await client.sendFile(extMsg.toBoc())
  console.log(`[highload-v3] External message sent, deployed=${isDeployed}, queryId=${queryId}`)
}

// ── Main ──

function getTonClient() {
  return new TonClient({ endpoint: TONCENTER_ENDPOINT, apiKey: TONCENTER_API_KEY })
}

async function getKeyPair() {
  return await mnemonicToPrivateKey(WALLET_TON_MNEMONIC.split(' '))
}

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
    const keyPair = await getKeyPair()
    const walletAddress = getWalletAddress(keyPair.publicKey)

    console.log(`[highload-v3] Wallet address: ${walletAddress.toString({ bounceable: false })}`)

    // Auto-fail stuck 'processing' withdrawals (> 5 min)
    await sb.rpc('cleanup_stuck_withdrawals')

    // Fetch TON price
    const tonPriceRub = await getTonPriceRub()
    if (!tonPriceRub || tonPriceRub <= 0) {
      await logToAdmin('error', 'Cannot fetch TON price, skipping run')
      return jsonResponse({ error: 'price_unavailable' })
    }

    // Check for active workers
    const { count: processingCount } = await sb
      .from('withdrawals')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'processing')
    if (processingCount && processingCount > 0) {
      return jsonResponse({ completed: 0, failed: 0, reason: 'worker_active', ton_price_rub: tonPriceRub })
    }

    // Pick ALL pending
    const { data: pending, error: pickErr } = await sb
      .from('withdrawals')
      .select('id, user_id, net_rub, ton_amount, ton_address, memo')
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .limit(MAX_BATCH_SIZE)

    if (pickErr) return jsonResponse({ error: pickErr.message })
    if (!pending || pending.length === 0) {
      return jsonResponse({ completed: 0, failed: 0, reason: 'empty_queue', ton_price_rub: tonPriceRub })
    }

    // Mark all as processing
    const ids = pending.map((w: { id: string }) => w.id)
    await sb.from('withdrawals').update({ status: 'processing' }).in('id', ids)

    console.log(`Processing batch of ${pending.length} withdrawals`)

    // Calculate TON amounts
    const validWithdrawals: { address: string; amountTon: number; memo: string; id: string }[] = []
    const failedIds: string[] = []

    for (const wd of pending) {
      let tonRounded: number
      if (wd.ton_amount && Number(wd.ton_amount) > 0) {
        tonRounded = Math.floor(Number(wd.ton_amount) * 1e9) / 1e9
      } else {
        tonRounded = Math.floor((wd.net_rub / tonPriceRub) * 1e9) / 1e9
      }

      if (tonRounded <= 0.001) {
        await sb.rpc('fail_withdrawal', { p_withdrawal_id: wd.id, p_error: `TON too small: ${tonRounded}` })
        failedIds.push(wd.id)
        continue
      }
      validWithdrawals.push({ address: wd.ton_address, amountTon: tonRounded, memo: wd.memo || '', id: wd.id })
    }

    if (validWithdrawals.length === 0) {
      return jsonResponse({ completed: 0, failed: failedIds.length, ton_price_rub: tonPriceRub })
    }

    // Check wallet balance
    const client = getTonClient()
    const walletBalance = Number(await client.getBalance(walletAddress)) / 1e9
    const totalTon = validWithdrawals.reduce((s, w) => s + w.amountTon, 0)
    const gasReserve = 0.1 + validWithdrawals.length * 0.01

    if (walletBalance < totalTon + gasReserve) {
      for (const wd of validWithdrawals) {
        await sb.rpc('fail_withdrawal', { p_withdrawal_id: wd.id, p_error: `Balance low: ${walletBalance.toFixed(4)}` })
        failedIds.push(wd.id)
      }
      await logToAdmin('error', 'Wallet balance too low', { balance: walletBalance, needed: totalTon + gasReserve })
      return jsonResponse({ completed: 0, failed: failedIds.length, reason: 'wallet_low_balance' })
    }

    // Send batch
    try {
      const messages = validWithdrawals.map(wd => ({
        to: Address.parse(wd.address),
        value: toNano(wd.amountTon.toFixed(9)),
        body: wd.memo || undefined,
      }))

      await sendBatch(client, keyPair.secretKey, keyPair.publicKey, messages as any)

      // Mark all completed
      const txRef = `highload-${Date.now()}`
      for (const wd of validWithdrawals) {
        await sb.rpc('complete_withdrawal', { p_withdrawal_id: wd.id, p_tx_hash: txRef, p_ton_amount: wd.amountTon })
      }

      const elapsed = Date.now() - startTime
      const summary = { completed: validWithdrawals.length, failed: failedIds.length, total_ton: totalTon, ton_price_rub: tonPriceRub, elapsed_ms: elapsed, mode: 'highload-v3' }
      console.log('Summary:', JSON.stringify(summary))
      await logToAdmin('info', `Batch: ${validWithdrawals.length} ok, ${failedIds.length} failed`, summary)
      return jsonResponse(summary)

    } catch (sendErr) {
      console.error('Batch send error:', sendErr)
      for (const wd of validWithdrawals) {
        try { await sb.rpc('fail_withdrawal', { p_withdrawal_id: wd.id, p_error: (sendErr as Error).message }) } catch {}
        failedIds.push(wd.id)
      }
      await logToAdmin('error', 'Batch send failed', { error: (sendErr as Error).message })
      return jsonResponse({ completed: 0, failed: failedIds.length, error: (sendErr as Error).message })
    }

  } catch (err) {
    console.error('Fatal error:', err)
    await logToAdmin('error', 'Fatal: ' + (err as Error).message, { stack: (err as Error).stack })
    return jsonResponse({ error: (err as Error).message }, 500)
  }
})

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

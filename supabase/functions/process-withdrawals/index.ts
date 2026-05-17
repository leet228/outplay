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

// ── USDT-on-TON jetton wallet ──
// Our jetton-wallet sub-contract for USDT (resolved once on chain
// via scripts/resolve-usdt-wallet.js). USDT withdrawals are
// implemented as a jetton transfer FROM this sub-contract TO the
// recipient's main TON address — the highload wallet just signs
// internal messages that target this address with a jetton-
// transfer body.
const USDT_JETTON_WALLET = 'UQD35azoUEPUPyTucTRbKj3SVOdtbB5-f3akyFyZmR7YAwyV'
// TON value to attach to each internal message that triggers a
// jetton transfer. Covers our jetton-wallet's storage + send + the
// notification gas forwarded to the recipient. ≈ 0.05 TON is the
// industry-standard amount; we leave a touch extra for safety.
const USDT_JETTON_FORWARD_TON   = 0.01   // tip sent to recipient with the notification
const USDT_JETTON_TRANSFER_VALUE = 0.05  // TON attached to our internal message

// Query ID tracking (persisted in-memory per Edge Function instance)
// Use timestamp-based shift to guarantee uniqueness across invocations
// 8191 possible shifts × 1023 bit numbers = ~8.3M unique IDs per 24h timeout
let queryShift = Math.floor(Date.now() / 1000) % 8191
let queryBitNumber = Math.floor(Math.random() * 1023)

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
    const rate = data?.rates?.RUB ?? 90
    // Mirror the live rate into app_settings so the Postgres
    // deposit-notification trigger can show balances in USD.
    await persistUsdRubRate(rate)
    return rate
  } catch { return 90 }
}

// Best-effort upsert of the USD→RUB rate. Service-role client
// bypasses RLS; failures here must never break withdrawal runs.
async function persistUsdRubRate(rate: number): Promise<void> {
  if (!Number.isFinite(rate) || rate <= 0) return
  try {
    await getSupabase()
      .from('app_settings')
      .upsert(
        { key: 'usd_rub_rate', value: rate, updated_at: new Date().toISOString() },
        { onConflict: 'key' },
      )
  } catch { /* non-fatal */ }
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

// Build a standard text-comment Cell (op = 0, then UTF-8 bytes).
function buildCommentCell(text: string): Cell {
  const bytes = new TextEncoder().encode(text)
  const b = beginCell().storeUint(0, 32)
  for (const x of bytes) b.storeUint(x, 8)
  return b.endCell()
}

// Build a TIP-3 jetton transfer body. This is what the highload
// wallet sends INTO our USDT jetton-wallet — the jetton-wallet
// then routes the USDT to the recipient's own jetton-wallet and
// optionally forwards a small TON tip + text comment.
//
//   op = 0x0f8a7ea5  (jetton.transfer)
//   query_id (uint64)
//   amount   (VarUInteger 16) — micro-USDT
//   destination       (MsgAddress) — recipient's MAIN TON address
//   response_destination (MsgAddress) — where unspent TON returns
//   custom_payload    (Maybe ^Cell) — always null here
//   forward_ton_amount (VarUInteger 16) — TON tipped along with the
//                       jetton, also covers recipient notification gas
//   forward_payload   (Either Cell ^Cell) — text comment if present
function buildJettonTransferBody(
  amountMicroUsdt: bigint,
  destination: Address,
  responseDestination: Address,
  forwardTonAmount: bigint,
  comment?: string,
): Cell {
  const b = beginCell()
    .storeUint(0x0f8a7ea5, 32)
    .storeUint(0, 64) // query_id — set to 0; deduplication happens via highload queryId
    .storeCoins(amountMicroUsdt)
    .storeAddress(destination)
    .storeAddress(responseDestination)
    .storeBit(false)            // no custom_payload
    .storeCoins(forwardTonAmount)

  if (comment && comment.length > 0) {
    // Forward payload as a referenced cell carrying the comment.
    b.storeBit(true)
    b.storeRef(buildCommentCell(comment))
  } else {
    // Empty forward_payload (no notification body).
    b.storeBit(false)
  }
  return b.endCell()
}

// Send a single transfer via Highload V3.
// Each withdrawal = one external message with direct ref to one
// internal message. The internal message body is either:
//   - empty   (TON transfer, no memo)
//   - a text-comment cell (TON transfer with memo)
//   - a jetton-transfer cell (USDT-on-TON withdrawal)
async function sendSingleTransfer(
  client: TonClient,
  secretKey: Uint8Array,
  publicKey: Uint8Array,
  to: Address,
  value: bigint,
  options: { memo?: string; bodyCell?: Cell } = {},
): Promise<void> {
  const walletAddress = getWalletAddress(publicKey)
  const { memo, bodyCell } = options

  // Build internal message
  const msgBuilder = beginCell()
    .storeUint(0x10, 6)        // int_msg_info, no bounce
    .storeAddress(to)
    .storeCoins(value)

  // Resolve which body (if any) attaches to this message.
  //   - bodyCell wins  → arbitrary cell (jetton transfer etc.)
  //   - memo present   → standard text-comment cell
  //   - neither        → empty body
  const effectiveBody: Cell | null = bodyCell
    ? bodyCell
    : (memo ? buildCommentCell(memo) : null)

  if (effectiveBody) {
    msgBuilder.storeUint(0, 1 + 4 + 4 + 64 + 32) // no state init fields
    msgBuilder.storeBit(false) // no state init
    msgBuilder.storeBit(true)  // body as ref
    msgBuilder.storeRef(effectiveBody)
  } else {
    msgBuilder.storeUint(0, 1 + 4 + 4 + 64 + 32 + 1 + 1) // no state init, no body
  }

  const internalMsg = msgBuilder.endCell()

  const qid = nextQueryId()
  const queryId = qid.shift * 1024 + qid.bitNumber
  const createdAt = Math.floor(Date.now() / 1000) - 10
  const mode = SendMode.PAY_GAS_SEPARATELY + SendMode.IGNORE_ERRORS

  // Signing message: subwalletId → ref(message) → mode → queryId → createdAt → timeout
  const signingMessage = beginCell()
    .storeUint(SUBWALLET_ID, 32)
    .storeRef(internalMsg)
    .storeUint(mode, 8)
    .storeUint(queryId, 23)
    .storeUint(createdAt, 64)
    .storeUint(TIMEOUT, 22)
    .endCell()

  const signature = sign(signingMessage.hash(), secretKey)

  const body = beginCell()
    .storeBuffer(signature, 64)
    .storeRef(signingMessage)
    .endCell()

  const extMsg = beginCell()
    .storeUint(0b10, 2)
    .storeUint(0, 2)
    .storeAddress(walletAddress)
    .storeCoins(0)
    .storeBit(false)  // no state init (already deployed)
    .storeBit(true)   // body as ref
    .storeRef(body)
    .endCell()

  await client.sendFile(extMsg.toBoc())
  console.log(`[highload-v3] Sent transfer, queryId=${queryId}`)
}

// Send multiple transfers — each as separate external message
// Highload V3 processes them without seqno blocking (parallel-safe).
// Each entry can carry either a `memo` (becomes a text-comment body)
// or a fully-built `bodyCell` (e.g. jetton transfer for USDT).
async function sendBatch(
  client: TonClient,
  secretKey: Uint8Array,
  publicKey: Uint8Array,
  messages: { to: Address; value: bigint; memo?: string; bodyCell?: Cell }[]
): Promise<void> {
  for (const msg of messages) {
    await sendSingleTransfer(client, secretKey, publicKey, msg.to, msg.value, {
      memo: msg.memo,
      bodyCell: msg.bodyCell,
    })
    // Small delay between sends to avoid rate limiting
    if (messages.length > 1) {
      await new Promise(r => setTimeout(r, 300))
    }
  }
  console.log(`[highload-v3] Batch of ${messages.length} transfers sent`)
}

// ── Main ──

function getTonClient() {
  return new TonClient({ endpoint: TONCENTER_ENDPOINT, apiKey: TONCENTER_API_KEY })
}

async function getKeyPair() {
  return await mnemonicToPrivateKey(WALLET_TON_MNEMONIC.split(' '))
}

// ── Auto-swap funding (USDT-TON ⇄ TON) ──
// If the Highload wallet is short of TON but holds spare USDT-TON
// (or vice-versa), fund the shortfall via a dex-swap, then pay out
// next tick once it lands. A single app_settings flag tracks the
// in-flight swap (one Highload wallet → one global flag is enough).
const USDT_MASTER   = 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs'
const ADMIN_TG_ID   = Deno.env.get('ADMIN_TG_ID') || '945676433'
const SWAP_HEADROOM = 1.03
const STON_SWAP_GAS = 0.2          // TON spent on a STON.fi swap tx
const SWAP_FLAG_KEY = 'ton_fund_swap'

async function getUsdtTonBalance(ownerNonBounceable: string): Promise<number> {
  try {
    const u = new URL('https://toncenter.com/api/v3/jetton/wallets')
    u.searchParams.set('owner_address', ownerNonBounceable)
    u.searchParams.set('jetton_address', USDT_MASTER)
    const r = await fetch(u.toString())
    return Number((await r.json())?.jetton_wallets?.[0]?.balance || 0) / 1e6
  } catch { return 0 }
}
async function getTonPriceUsd(): Promise<number> {
  try {
    const res = await fetchWithRetry('https://api.coinlore.net/api/ticker/?id=54683')
    const p = parseFloat((await res.json())?.[0]?.price_usd)
    return Number.isFinite(p) && p > 0 ? p : 0
  } catch { return 0 }
}
async function adminUserId(): Promise<string | null> {
  const { data } = await getSupabase().from('users')
    .select('id').eq('telegram_id', ADMIN_TG_ID).maybeSingle()
  return (data as { id?: string } | null)?.id ?? null
}
async function callDexSwap(dir: string, amount: number): Promise<any> {
  const uid = await adminUserId()
  if (!uid) return { error: 'no_admin_user' }
  const r = await fetch(`${SUPABASE_URL}/functions/v1/dex-swap`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` },
    body: JSON.stringify({ user_id: uid, dir, amount: amount.toFixed(6), slippage: 0.01 }),
  })
  return r.json().catch(() => ({ error: `http_${r.status}` }))
}
async function getSwapFlag(): Promise<{ dir: string; txid: string; at: number } | null> {
  const { data } = await getSupabase().from('app_settings')
    .select('value').eq('key', SWAP_FLAG_KEY).maybeSingle()
  const v = (data as { value?: any } | null)?.value
  return v && typeof v === 'object' && v.at ? v : null
}
async function setSwapFlag(v: { dir: string; txid: string; at: number } | null) {
  const sb = getSupabase()
  if (v === null) {
    await sb.from('app_settings').delete().eq('key', SWAP_FLAG_KEY)
  } else {
    await sb.from('app_settings').upsert(
      { key: SWAP_FLAG_KEY, value: v, updated_at: new Date().toISOString() },
      { onConflict: 'key' },
    )
  }
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

    const _body = await req.json().catch(() => ({}))

    // ── action:'request' — feasibility gate (mirrors crypto) ──
    // Accept only if the Highload wallet can fund it (asset in hand
    // OR enough of the other asset to swap, incl. 3% headroom).
    // Otherwise 'network_unavailable' and the balance is NOT touched.
    if (_body?.action === 'request') {
      const kind = _body.kind === 'usdt-ton' ? 'usdt-ton' : 'ton'
      const user_id = _body.user_id
      const addr = String(_body.ton_address || '').trim()
      const memo = String(_body.memo || '')
      const amount = Math.round(Number(_body.amount_rub) || 0)
      if (!user_id || !(amount > 0) || addr.length < 10) {
        return jsonResponse({ error: 'bad_params' }, 400)
      }
      const kp = await getKeyPair()
      const wa = getWalletAddress(kp.publicKey)
      const [usdRub, tonUsd] = await Promise.all([getUsdRubRate(), getTonPriceUsd()])
      if (!(tonUsd > 0) || !(usdRub > 0)) {
        return jsonResponse({ error: 'price_unavailable' }, 503)
      }
      const gas = kind === 'usdt-ton' ? 25 : 3
      const net = amount * 0.99 - gas
      if (net <= 0) return jsonResponse({ error: 'amount_too_small_after_fees' })
      const netUsd = net / usdRub

      const tonBal  = Number(await getTonClient().getBalance(wa)) / 1e9
      const usdtBal = await getUsdtTonBalance(wa.toString({ bounceable: false }))

      let feasible: boolean
      if (kind === 'usdt-ton') {
        const needUsdt = netUsd
        feasible = usdtBal >= needUsdt ||
          tonBal >= (needUsdt / tonUsd) * SWAP_HEADROOM + STON_SWAP_GAS
      } else {
        const needTon = netUsd / tonUsd
        feasible = tonBal >= needTon ||
          usdtBal >= needTon * tonUsd * SWAP_HEADROOM
      }
      if (!feasible) return jsonResponse({ error: 'network_unavailable' })

      const fn = kind === 'usdt-ton' ? 'request_usdt_withdrawal' : 'request_withdrawal'
      const { data: rpc } = await getSupabase().rpc(fn, {
        p_user_id: user_id, p_amount_rub: amount, p_ton_address: addr, p_memo: memo,
      })
      return jsonResponse(rpc ?? { error: 'rpc_failed' })
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

    // Live USD-RUB rate — needed for USDT (pegged to USD).
    const usdRubRate = await getUsdRubRate()

    // Pick ALL pending — both TON and USDT in one pass.
    // `usdt_amount` is read so admin USDT withdrawals can preset
    // the exact send amount the same way `ton_amount` does for
    // admin TON withdrawals.
    const { data: pending, error: pickErr } = await sb
      .from('withdrawals')
      .select('id, user_id, net_rub, ton_amount, usdt_amount, ton_address, memo, asset')
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

    // ── Split & convert per asset ──
    // TON withdrawals: net_rub → TON using live TON price.
    // USDT withdrawals: net_rub → USDT using live USD-RUB rate
    //                   (USDT ≈ $1 peg).
    interface TonWd  { id: string; address: string; amountTon: number;  memo: string }
    interface UsdtWd { id: string; address: string; amountUsdt: number; memo: string }
    const tonWds:  TonWd[]  = []
    const usdtWds: UsdtWd[] = []
    const failedIds: string[] = []

    for (const wd of pending) {
      const asset = (wd as { asset?: string }).asset || 'ton'

      if (asset === 'usdt-ton') {
        // Admin USDT withdrawals pre-set usdt_amount so we send
        // exactly that. Regular user USDT rows have usdt_amount=NULL
        // and rely on net_rub / usd-rub-rate. Floor to 6 decimals
        // (USDT precision on TON) in both paths.
        const presetUsdt = (wd as { usdt_amount?: number | string | null }).usdt_amount
        let usdtRounded: number
        if (presetUsdt != null && Number(presetUsdt) > 0) {
          usdtRounded = Math.floor(Number(presetUsdt) * 1e6) / 1e6
        } else {
          usdtRounded = Math.floor((wd.net_rub / usdRubRate) * 1e6) / 1e6
        }
        if (!Number.isFinite(usdtRounded) || usdtRounded <= 0.001) {
          await sb.rpc('fail_withdrawal', { p_withdrawal_id: wd.id, p_error: `USDT too small: ${usdtRounded}` })
          failedIds.push(wd.id)
          continue
        }
        usdtWds.push({ id: wd.id, address: wd.ton_address, amountUsdt: usdtRounded, memo: wd.memo || '' })
      } else {
        // TON path — unchanged from the original flow.
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
        tonWds.push({ id: wd.id, address: wd.ton_address, amountTon: tonRounded, memo: wd.memo || '' })
      }
    }

    if (tonWds.length === 0 && usdtWds.length === 0) {
      return jsonResponse({ completed: 0, failed: failedIds.length, ton_price_rub: tonPriceRub })
    }

    // ── Wallet balance check ──
    // Native TON withdrawals consume their full amountTon. USDT
    // withdrawals consume USDT_JETTON_TRANSFER_VALUE TON each
    // (covers our jetton-wallet's send + recipient notification).
    const client = getTonClient()
    const walletBalance = Number(await client.getBalance(walletAddress)) / 1e9
    const totalTon       = tonWds.reduce((s, w) => s + w.amountTon, 0)
    const totalUsdtTonGas = usdtWds.length * USDT_JETTON_TRANSFER_VALUE
    const gasReserve     = 0.1 + (tonWds.length + usdtWds.length) * 0.01
    const totalRequired  = totalTon + totalUsdtTonGas + gasReserve
    const usdtBal        = await getUsdtTonBalance(walletAddress.toString({ bounceable: false }))
    const totalUsdtNeed  = usdtWds.reduce((s, w) => s + w.amountUsdt, 0)
    const liveIds        = [...tonWds, ...usdtWds].map(w => w.id)
    const revertPending  = () => sb.from('withdrawals').update({ status: 'pending' }).in('id', liveIds)

    const tonOk  = walletBalance >= totalRequired
    const usdtOk = usdtBal >= totalUsdtNeed
    const flag   = await getSwapFlag()

    if (flag) {
      if (tonOk && usdtOk) {
        await setSwapFlag(null)                 // funded → fall through to send
      } else if (Date.now() - flag.at > 12 * 60 * 1000) {
        await setSwapFlag(null)
        for (const wd of [...tonWds, ...usdtWds]) {
          await sb.rpc('fail_withdrawal', { p_withdrawal_id: wd.id, p_error: 'Swap funding timeout (12min)' })
          failedIds.push(wd.id)
        }
        await logToAdmin('error', 'TON funding swap timed out', { flag })
        return jsonResponse({ completed: 0, failed: failedIds.length, reason: 'swap_timeout' })
      } else {
        await revertPending()                   // still settling — wait
        return jsonResponse({ completed: 0, failed: 0, reason: 'awaiting_swap', swap: flag.txid })
      }
    } else if (!tonOk || !usdtOk) {
      const tonUsd = await getTonPriceUsd()
      if (!(tonUsd > 0)) {
        await revertPending()
        return jsonResponse({ completed: 0, failed: 0, reason: 'price_unavailable' })
      }
      const usdtSurplus = usdtBal - totalUsdtNeed
      const tonSurplus  = walletBalance - totalRequired

      if (!tonOk) {
        // short of TON → swap spare USDT-TON → TON
        const needUsdt = (totalRequired - walletBalance) * tonUsd * SWAP_HEADROOM
        if (usdtSurplus > 0 && usdtSurplus >= needUsdt) {
          const sr = await callDexSwap('usdt_to_ton', needUsdt)
          await revertPending()
          if (sr?.ok && sr?.step === 'swap') {
            await setSwapFlag({ dir: 'usdt_to_ton', txid: sr.txid, at: Date.now() })
            await logToAdmin('info', 'TON funding swap fired', { needUsdt, txid: sr.txid })
            return jsonResponse({ completed: 0, failed: 0, reason: 'swap_fired', swap: sr.txid })
          }
          return jsonResponse({ completed: 0, failed: 0, reason: 'swap_retry', detail: String(sr?.error || '') })
        }
      } else {
        // short of USDT-TON → swap spare TON → USDT-TON
        const needTon = ((totalUsdtNeed - usdtBal) / tonUsd) * SWAP_HEADROOM + STON_SWAP_GAS
        if (tonSurplus > 0 && tonSurplus >= needTon) {
          const sr = await callDexSwap('ton_to_usdt', needTon)
          await revertPending()
          if (sr?.ok && sr?.step === 'swap') {
            await setSwapFlag({ dir: 'ton_to_usdt', txid: sr.txid, at: Date.now() })
            await logToAdmin('info', 'USDT-TON funding swap fired', { needTon, txid: sr.txid })
            return jsonResponse({ completed: 0, failed: 0, reason: 'swap_fired', swap: sr.txid })
          }
          return jsonResponse({ completed: 0, failed: 0, reason: 'swap_retry', detail: String(sr?.error || '') })
        }
      }

      // neither asset can cover → genuine shortfall: fail + refund
      for (const wd of [...tonWds, ...usdtWds]) {
        await sb.rpc('fail_withdrawal', {
          p_withdrawal_id: wd.id,
          p_error: `Treasury short (TON ${walletBalance.toFixed(3)}/${totalRequired.toFixed(3)}, USDT ${usdtBal.toFixed(2)}/${totalUsdtNeed.toFixed(2)})`,
        })
        failedIds.push(wd.id)
      }
      await logToAdmin('error', 'TON wallet short, no swap cover',
        { walletBalance, totalRequired, usdtBal, totalUsdtNeed })
      return jsonResponse({ completed: 0, failed: failedIds.length, reason: 'wallet_low_balance' })
    }

    // ── Build batch messages ──
    // TON withdrawals: plain transfer with text-comment memo.
    // USDT withdrawals: internal message TO our jetton-wallet
    // with a jetton_transfer body that routes USDT to the recipient.
    const usdtJettonWallet = Address.parse(USDT_JETTON_WALLET)
    const messages: { to: Address; value: bigint; memo?: string; bodyCell?: Cell }[] = []

    for (const wd of tonWds) {
      messages.push({
        to:    Address.parse(wd.address),
        value: toNano(wd.amountTon.toFixed(9)),
        memo:  wd.memo || undefined,
      })
    }

    for (const wd of usdtWds) {
      const microUsdt    = BigInt(Math.round(wd.amountUsdt * 1e6))
      const jettonBody = buildJettonTransferBody(
        microUsdt,
        Address.parse(wd.address),  // recipient main TON address
        walletAddress,              // refunds + excess TON → our highload
        toNano(USDT_JETTON_FORWARD_TON.toFixed(9)),
        wd.memo || undefined,
      )
      messages.push({
        to:       usdtJettonWallet,
        value:    toNano(USDT_JETTON_TRANSFER_VALUE.toFixed(9)),
        bodyCell: jettonBody,
      })
    }

    // ── Sign + send ──
    try {
      await sendBatch(client, keyPair.secretKey, keyPair.publicKey, messages)

      const txRef = `highload-${Date.now()}`
      for (const wd of tonWds) {
        await sb.rpc('complete_withdrawal',      { p_withdrawal_id: wd.id, p_tx_hash: txRef, p_ton_amount:  wd.amountTon })
      }
      for (const wd of usdtWds) {
        await sb.rpc('complete_usdt_withdrawal', { p_withdrawal_id: wd.id, p_tx_hash: txRef, p_usdt_amount: wd.amountUsdt })
      }

      const elapsed = Date.now() - startTime
      const summary = {
        completed:    tonWds.length + usdtWds.length,
        completed_ton:  tonWds.length,
        completed_usdt: usdtWds.length,
        failed:        failedIds.length,
        total_ton:     totalTon,
        total_usdt:    usdtWds.reduce((s, w) => s + w.amountUsdt, 0),
        ton_price_rub: tonPriceRub,
        usd_rub_rate:  usdRubRate,
        elapsed_ms:    elapsed,
        mode:          'highload-v3',
      }
      console.log('Summary:', JSON.stringify(summary))
      await logToAdmin('info', `Batch: ${tonWds.length} TON + ${usdtWds.length} USDT ok, ${failedIds.length} failed`, summary)
      return jsonResponse(summary)

    } catch (sendErr) {
      console.error('Batch send error:', sendErr)
      for (const wd of [...tonWds, ...usdtWds]) {
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

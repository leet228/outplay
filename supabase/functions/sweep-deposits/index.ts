// ╔══════════════════════════════════════════════════════════════╗
// ║  sweep-deposits — move CREDITED deposits → treasury (idx 0)  ║
// ╚══════════════════════════════════════════════════════════════╝
//
// Step 4. Only credited deposits get a sweep_job (enqueue from
// crypto_processed_txs), so we never move funds we didn't credit
// and every move is audited in sweep_jobs.
//
// Treasury = HD index 0 (server-derivable from HD_MASTER_MNEMONIC
// — no extra key secrets). It is BOTH the sweep destination and
// the gas source: a token sweep first tops the user address up
// with native coin from the treasury, then transfers the token.
//
// THIS RELEASE: EVM fully (ETH/BNB native + USDT/USDC ERC20/BEP20
// with gas top-up) via ethers + NowNodes RPC. TRON / BTC / LTC
// executors land next (kept 'pending', no funds moved) — rushing
// an unverified signer for real, irreversible money is worse than
// one more focused pass.
//
// Idempotency / self-heal: a sweep broadcast sets status
// 'sweeping' + txid; a later run that sees the address drained
// flips it to 'swept'; if the balance is still there (tx
// dropped) it re-sends. Same shape for gas ('gassing').

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import {
  HDNodeWallet, JsonRpcProvider, FetchRequest, Wallet, Contract,
  SigningKey, keccak256, sha256, getBytes, encodeBase58, decodeBase58,
} from 'https://esm.sh/ethers@6.13.4'

const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const HD_MASTER_MNEMONIC   = Deno.env.get('HD_MASTER_MNEMONIC') || ''
const NOWNODES_API_KEY     = Deno.env.get('NOWNODES_API_KEY') || ''

const JOB_LIMIT = 20

// chain → which EVM network + token contract/decimals (or native)
const EVM_NET: Record<string, 'eth' | 'bsc'> = {
  eth: 'eth', 'usdt-erc20': 'eth', 'usdc-erc20': 'eth',
  bnb: 'bsc', 'usdt-bep20': 'bsc', 'usdc-bep20': 'bsc',
}
const EVM_TOKEN: Record<string, { addr: string; dec: number }> = {
  'usdt-erc20': { addr: '0xdAC17F958D2ee523a2206206994597C13D831ec7', dec: 6 },
  'usdc-erc20': { addr: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', dec: 6 },
  'usdt-bep20': { addr: '0x55d398326f99059fF775485246999027B3197955', dec: 18 },
  'usdc-bep20': { addr: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', dec: 18 },
}
const NATIVE_EVM = new Set(['eth', 'bnb'])
const RPC_URL = {
  eth: 'https://eth.nownodes.io',
  bsc: 'https://bsc.nownodes.io',
}
const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address,uint256) returns (bool)',
]

let supabase: ReturnType<typeof createClient>
const sb = () => (supabase ??= createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY))

async function logAdmin(level: string, message: string, details: Record<string, unknown> = {}) {
  try {
    await sb().rpc('admin_log', {
      p_level: level, p_source: 'edge:sweep-deposits',
      p_message: message, p_details: details,
    })
  } catch (e) { console.error('admin_log:', e) }
}

function providerFor(net: 'eth' | 'bsc'): JsonRpcProvider {
  const fr = new FetchRequest(RPC_URL[net])
  if (NOWNODES_API_KEY) fr.setHeader('api-key', NOWNODES_API_KEY)
  return new JsonRpcProvider(fr)
}

function evmWalletAt(index: number, provider: JsonRpcProvider): Wallet {
  const n = HDNodeWallet.fromPhrase(
    HD_MASTER_MNEMONIC, undefined, `m/44'/60'/0'/0/${index}`,
  )
  return new Wallet(n.privateKey, provider)
}

async function setJob(
  id: string, status: string | null,
  gasTxid: string | null, sweepTxid: string | null, err: string | null,
) {
  await sb().rpc('update_sweep_job', {
    p_id: id, p_status: status,
    p_gas_txid: gasTxid, p_sweep_txid: sweepTxid, p_error: err,
  })
}

// ── EVM job processor ────────────────────────────────────────
async function processEvmJob(job: any, treasuryEvm: string) {
  const net = EVM_NET[job.chain]
  const provider = providerFor(net)
  const treasury = HDNodeWallet.fromPhrase(
    HD_MASTER_MNEMONIC, undefined, `m/44'/60'/0'/0/0`,
  )
  const userWallet = evmWalletAt(job.derivation_index, provider)
  const fee = await provider.getFeeData()
  const gasPrice = fee.gasPrice ?? 3_000_000_000n

  if (NATIVE_EVM.has(job.chain)) {
    // Native ETH / BNB: send (balance − fee) to treasury.
    const bal = await provider.getBalance(userWallet.address)
    const cost = gasPrice * 21000n
    if (bal <= cost) {
      // already drained → confirm terminal
      await setJob(job.id, 'swept', null, job.sweep_txid ?? null, 'empty')
      return
    }
    const value = bal - cost
    const tx = await userWallet.sendTransaction({
      to: treasuryEvm, value, gasLimit: 21000n, gasPrice,
    })
    await setJob(job.id, 'sweeping', null, tx.hash, null)
    return
  }

  // Token (USDT/USDC on ERC20/BEP20).
  const tk = EVM_TOKEN[job.chain]
  const token = new Contract(tk.addr, ERC20_ABI, userWallet)
  const tokenBal: bigint = await token.balanceOf(userWallet.address)
  if (tokenBal <= 0n) {
    await setJob(job.id, 'swept', null, job.sweep_txid ?? null, 'empty')
    return
  }

  // Gas needed on the USER address to send one ERC20 transfer.
  const gasLimit = 70000n
  const need = gasPrice * gasLimit
  const userNative = await provider.getBalance(userWallet.address)

  if (userNative < need) {
    // Top up gas from treasury (treasury pays its own 21000 fee).
    const treasuryW = new Wallet(treasury.privateKey, provider)
    const tBal = await provider.getBalance(treasuryW.address)
    const topUp = need - userNative
    if (tBal < topUp + gasPrice * 21000n) {
      await setJob(job.id, 'needs_gas', null, null,
        `treasury_low:${net}`)
      await logAdmin('warn', 'treasury gas low', { net, chain: job.chain })
      return
    }
    const gtx = await treasuryW.sendTransaction({
      to: userWallet.address, value: topUp, gasLimit: 21000n, gasPrice,
    })
    await setJob(job.id, 'gassing', gtx.hash, null, null)
    return
  }

  // Enough gas → sweep the whole token balance to treasury.
  const stx = await token.transfer(treasuryEvm, tokenBal, { gasLimit, gasPrice })
  await setJob(job.id, 'sweeping', job.gas_txid ?? null, stx.hash, null)
}

// ══════════════ TRON (TRX + USDT-TRC20) ══════════════
// Build via TronGrid (createtransaction / triggersmartcontract),
// sign the txID locally with secp256k1 (ethers — no TronWeb in
// Deno), broadcast. Treasury = HD index 0 Tron address; it funds
// the user address with TRX so a TRC20 transfer can pay energy.

const TRON_API   = 'https://api.trongrid.io'
const TRON_KEY   = Deno.env.get('TRONGRID_API_KEY') || ''
const TRON_USDT  = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'   // base58
const SUN        = 1_000_000n
// USDT transfer with no staked energy burns TRX; top the user
// address up generously and cap the on-chain fee.
const TRC20_TOPUP_SUN  = 40n * SUN     // sent to the user addr
const TRC20_MIN_SUN    = 30n * SUN     // sweep only if addr ≥ this
const TRC20_FEE_LIMIT  = 50_000_000    // 50 TRX hard cap (sun)
const TRX_BW_RESERVE   = 1_200_000n    // ~1.2 TRX kept for bandwidth

function tronPriv(index: number): string {
  return HDNodeWallet.fromPhrase(
    HD_MASTER_MNEMONIC, undefined, `m/44'/195'/0'/0/${index}`,
  ).privateKey
}

// privateKey → Tron base58check address (matches hd-derive.js).
function tronAddrFromPriv(priv: string): string {
  const pub = getBytes(SigningKey.computePublicKey(priv, false)).slice(1)
  const h = getBytes(keccak256(pub))
  const a21 = new Uint8Array(21)
  a21[0] = 0x41
  a21.set(h.slice(-20), 1)
  const chk = getBytes(sha256(sha256(a21))).slice(0, 4)
  const full = new Uint8Array(25)
  full.set(a21, 0); full.set(chk, 21)
  return encodeBase58(full)
}

// base58check Tron addr → 21-byte (0x41-prefixed) hex bytes.
function tronB58ToBytes21(b58: string): Uint8Array {
  let hex = decodeBase58(b58).toString(16)
  if (hex.length % 2) hex = '0' + hex
  return getBytes('0x' + hex).slice(0, 21) // drop 4-byte checksum
}

async function tronRpc(path: string, body: unknown): Promise<any> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (TRON_KEY) headers['TRON-PRO-API-KEY'] = TRON_KEY
  const r = await fetch(`${TRON_API}${path}`, {
    method: 'POST', headers, body: JSON.stringify(body),
  })
  if (!r.ok) throw new Error(`trongrid ${path} HTTP ${r.status}`)
  return await r.json()
}

function signTron(tx: any, priv: string): any {
  const sk = new SigningKey(priv)
  const sig = sk.sign('0x' + tx.txID)
  const hex = sig.r.slice(2) + sig.s.slice(2) + (sig.yParity ? '01' : '00')
  return { ...tx, signature: [hex] }
}

async function tronTrxBalanceSun(b58: string): Promise<bigint> {
  const a = await tronRpc('/wallet/getaccount', { address: b58, visible: true })
  return BigInt(a?.balance ?? 0)
}

async function tronUsdtBalance(b58: string): Promise<bigint> {
  const param = '0'.repeat(24) +
    Array.from(tronB58ToBytes21(b58).slice(1))
      .map(x => x.toString(16).padStart(2, '0')).join('')
  const r = await tronRpc('/wallet/triggerconstantcontract', {
    owner_address: b58, contract_address: TRON_USDT,
    function_selector: 'balanceOf(address)', parameter: param, visible: true,
  })
  const hex = r?.constant_result?.[0]
  return hex ? BigInt('0x' + hex) : 0n
}

// Send native TRX b58→b58 (amount in sun). Returns txid.
async function tronSendTrx(fromPriv: string, fromB58: string, toB58: string, amountSun: bigint): Promise<string> {
  const built = await tronRpc('/wallet/createtransaction', {
    owner_address: fromB58, to_address: toB58,
    amount: Number(amountSun), visible: true,
  })
  if (!built?.txID) throw new Error('createtransaction failed: ' + JSON.stringify(built).slice(0, 200))
  const signed = signTron(built, fromPriv)
  const res = await tronRpc('/wallet/broadcasttransaction', signed)
  if (res?.result !== true && !res?.txid) throw new Error('broadcast trx: ' + JSON.stringify(res).slice(0, 200))
  return built.txID
}

// TRC20 transfer (user → treasury), full balance. Returns txid.
async function tronSendUsdt(fromPriv: string, fromB58: string, toB58: string, amount: bigint): Promise<string> {
  const toParam = '0'.repeat(24) +
    Array.from(tronB58ToBytes21(toB58).slice(1))
      .map(x => x.toString(16).padStart(2, '0')).join('')
  const amtParam = amount.toString(16).padStart(64, '0')
  const r = await tronRpc('/wallet/triggersmartcontract', {
    owner_address: fromB58, contract_address: TRON_USDT,
    function_selector: 'transfer(address,uint256)',
    parameter: toParam + amtParam,
    fee_limit: TRC20_FEE_LIMIT, call_value: 0, visible: true,
  })
  const tx = r?.transaction
  if (!tx?.txID) throw new Error('triggersmartcontract failed: ' + JSON.stringify(r).slice(0, 200))
  const signed = signTron(tx, fromPriv)
  const res = await tronRpc('/wallet/broadcasttransaction', signed)
  if (res?.result !== true && !res?.txid) throw new Error('broadcast trc20: ' + JSON.stringify(res).slice(0, 200))
  return tx.txID
}

async function processTronJob(job: any) {
  const treasuryB58 = tronAddrFromPriv(tronPriv(0))
  const userPriv = tronPriv(job.derivation_index)
  const userB58 = job.from_address as string

  if (job.chain === 'trx') {
    // Native: sweep balance minus a bandwidth reserve. Skip if the
    // address still owes a token sweep (don't steal its gas).
    const { data: sib } = await sb()
      .from('sweep_jobs').select('id')
      .eq('from_address', userB58).eq('chain', 'usdt-trc20')
      .neq('status', 'swept').limit(1)
    if (Array.isArray(sib) && sib.length > 0) {
      await setJob(job.id, 'pending', null, null, 'await_token_sweep')
      return
    }
    const bal = await tronTrxBalanceSun(userB58)
    if (bal <= TRX_BW_RESERVE) {
      await setJob(job.id, 'swept', null, job.sweep_txid ?? null, 'empty')
      return
    }
    const txid = await tronSendTrx(userPriv, userB58, treasuryB58, bal - TRX_BW_RESERVE)
    await setJob(job.id, 'sweeping', null, txid, null)
    return
  }

  // usdt-trc20
  const usdt = await tronUsdtBalance(userB58)
  if (usdt <= 0n) {
    await setJob(job.id, 'swept', null, job.sweep_txid ?? null, 'empty')
    return
  }
  const trx = await tronTrxBalanceSun(userB58)
  if (trx < TRC20_MIN_SUN) {
    // Gas top-up from treasury.
    const treasuryPriv = tronPriv(0)
    const tBal = await tronTrxBalanceSun(treasuryB58)
    if (tBal < TRC20_TOPUP_SUN + TRX_BW_RESERVE) {
      await setJob(job.id, 'needs_gas', null, null, 'treasury_low:trx')
      await logAdmin('warn', 'treasury TRX low', { need: String(TRC20_TOPUP_SUN) })
      return
    }
    const gtxid = await tronSendTrx(treasuryPriv, treasuryB58, userB58, TRC20_TOPUP_SUN)
    await setJob(job.id, 'gassing', gtxid, null, null)
    return
  }
  // Enough TRX → move the whole USDT balance to treasury.
  const stxid = await tronSendUsdt(userPriv, userB58, treasuryB58, usdt)
  await setJob(job.id, 'sweeping', job.gas_txid ?? null, stxid, null)
}

serve(async (_req) => {
  const t0 = Date.now()
  try {
    if (!HD_MASTER_MNEMONIC) {
      await logAdmin('error', 'HD_MASTER_MNEMONIC not set')
      return new Response(JSON.stringify({ error: 'no_master' }), { status: 500 })
    }

    // 1. Turn freshly-credited deposits into sweep jobs.
    const { data: queued } = await sb().rpc('enqueue_sweep_jobs')

    // 2. Claim a batch of actionable jobs.
    const { data: jobs, error: claimErr } = await sb().rpc('claim_sweep_jobs', {
      p_limit: JOB_LIMIT,
    })
    if (claimErr) {
      await logAdmin('error', 'claim_sweep_jobs failed: ' + claimErr.message)
      return new Response(JSON.stringify({ error: 'claim_failed' }), { status: 500 })
    }
    const list: any[] = Array.isArray(jobs) ? jobs : []

    // Treasury EVM destination (index 0).
    const treasuryEvm = HDNodeWallet.fromPhrase(
      HD_MASTER_MNEMONIC, undefined, `m/44'/60'/0'/0/0`,
    ).address

    let swept = 0, gassed = 0, deferred = 0, errors = 0

    for (const job of list) {
      try {
        if (EVM_NET[job.chain]) {
          await processEvmJob(job, treasuryEvm)
          swept++   // "advanced"; precise state lives in sweep_jobs
        } else if (job.chain === 'trx' || job.chain === 'usdt-trc20') {
          await processTronJob(job)
          swept++
        } else {
          // BTC / LTC — executor not shipped yet. Keep the job
          // pending; NO funds moved.
          await setJob(job.id, 'pending', null, null, `executor_pending:${job.chain}`)
          deferred++
        }
      } catch (e) {
        errors++
        await setJob(job.id, null, null, null, 'exec:' + String(e).slice(0, 240))
        await logAdmin('error', 'job exec failed', {
          job_id: job.id, chain: job.chain, err: String(e).slice(0, 400),
        })
      }
    }

    const summary = {
      queued: queued ?? 0, claimed: list.length,
      advanced: swept, gassed, deferred, errors,
      elapsed_ms: Date.now() - t0,
    }
    console.log('Summary:', JSON.stringify(summary))
    if (errors > 0) await logAdmin('warn', 'sweep run had errors', summary)
    return new Response(JSON.stringify(summary), {
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (err) {
    console.error('Worker error:', err)
    await logAdmin('error', 'Unhandled: ' + (err as Error).message,
      { stack: (err as Error).stack })
    return new Response(JSON.stringify({ error: 'internal' }), { status: 500 })
  }
})

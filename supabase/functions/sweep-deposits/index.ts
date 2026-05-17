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
          const before = job.status
          await processEvmJob(job, treasuryEvm)
          // crude counters from the resulting transition
          if (before !== 'swept') {
            // re-read not needed for stats; approximate
            swept++  // counts "advanced"; precise state in DB
          }
        } else {
          // TRON / BTC / LTC — executor not shipped yet. Keep the
          // job pending; NO funds moved.
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

// ╔══════════════════════════════════════════════════════════════╗
// ║  dex-swap — admin TON↔USDT(TON) swap via STON.fi            ║
// ╚══════════════════════════════════════════════════════════════╝
//
// Phase 1: MANUAL — the admin triggers a swap from the Wallet
// "Свап монет" card. The STON.fi SDK computes {to,value,body};
// we sign+send it from the SAME Highload V3 wallet that holds
// TON + USDT-TON (mirrors process-withdrawals). Self-contained
// (Highload code inlined) so the Supabase bundler is happy.
// Later the rebalance cron can call this automatically.
//
// POST { user_id, dir: 'ton_to_usdt'|'usdt_to_ton', amount,
//        slippage }   amount = TON (for ton_to_usdt) or USDT
//        (for usdt_to_ton); slippage e.g. 0.01 = 1%.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import {
  TonClient, Address, toNano, Cell, beginCell, SendMode, contractAddress,
} from 'npm:@ton/ton@15'
import { mnemonicToPrivateKey, sign } from 'npm:@ton/crypto@3'
import { StonApiClient } from 'npm:@ston-fi/api'
import { dexFactory } from 'npm:@ston-fi/sdk'
import {
  HDNodeWallet, SigningKey, keccak256, sha256 as eSha256, getBytes,
  encodeBase58, decodeBase58, AbiCoder,
  JsonRpcProvider, FetchRequest, Wallet, Contract,
  parseEther, parseUnits, MaxUint256,
} from 'https://esm.sh/ethers@6.13.4'

const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const WALLET_TON_MNEMONIC  = Deno.env.get('WALLET_TON_MNEMONIC')!
const TONCENTER_API_KEY    = Deno.env.get('TONCENTER_API_KEY') || undefined
const ADMIN_TG             = Deno.env.get('ADMIN_TG_ID') || '945676433'
const HD_MASTER_MNEMONIC   = Deno.env.get('HD_MASTER_MNEMONIC') || ''
const NOWNODES_API_KEY     = Deno.env.get('NOWNODES_API_KEY') || ''

// ── EVM (Ethereum/Uniswap V2 + BSC/PancakeSwap V2) ──
// Both are Uniswap-V2 forks → identical swapExact*ForTokens /
// ForETH flow. NOTE: ETH USDT/USDC = 6 dec, BSC USDT/USDC = 18.
const UNI_ABI = [
  'function getAmountsOut(uint256,address[]) view returns (uint256[])',
  'function swapExactETHForTokens(uint256,address[],address,uint256) payable returns (uint256[])',
  'function swapExactTokensForETH(uint256,uint256,address[],address,uint256) returns (uint256[])',
]
const ERC20_ABI = [
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
]
const EVM_CHAIN: Record<string, {
  rpc: string; router: string; weth: string;
  usdt: string; usdc: string; tokDec: number; native: string;
}> = {
  eth: {
    rpc: 'https://eth.nownodes.io',
    router: Deno.env.get('UNISWAP_ROUTER') || '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D',
    weth: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    usdt: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    usdc: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    tokDec: 6, native: 'ETH',
  },
  bnb: {
    rpc: 'https://bsc.nownodes.io',
    router: Deno.env.get('PANCAKE_ROUTER') || '0x10ED43C718714eb63d5aA57B78B54704E256024E',
    weth: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', // WBNB
    usdt: '0x55d398326f99059fF775485246999027B3197955',
    usdc: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
    tokDec: 18, native: 'BNB',
  },
}
function evmTreasuryWallet(rpc: string): Wallet {
  const fr = new FetchRequest(rpc)
  if (NOWNODES_API_KEY) fr.setHeader('api-key', NOWNODES_API_KEY)
  const node = HDNodeWallet.fromPhrase(HD_MASTER_MNEMONIC, undefined, "m/44'/60'/0'/0/0")
  return new Wallet(node.privateKey, new JsonRpcProvider(fr))
}

const USDT_MASTER = 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs'
const TONCENTER_ENDPOINT = 'https://toncenter.com/api/v2/jsonRPC'

// ── TRON / SunSwap Smart Router ──
const TRON_API     = 'https://trx.nownodes.io'
// SunSwap Smart Router (the classic V2 router is deprecated).
// Overridable via env in case SunSwap rotates it.
// The LIVE SunSwap V2 router that sunswap.com itself calls
// (Uniswap-V2 style: swapExactETHForTokens, selector 0x7ff36ab5).
// Verified from a real on-site swap. Overridable via env.
const SUN_ROUTER   = Deno.env.get('SUNSWAP_ROUTER') || 'TNJVzGqKBWkJxJB5XYSqGAwUTV15U24pPq'
const WTRX         = 'TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR'      // Wrapped TRX (native repr in the router API)
const TRON_USDT    = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'      // USDT-TRC20
const TRON_FEE_LIMIT = 100_000_000                            // 100 TRX cap
const abi = AbiCoder.defaultAbiCoder()

function tronPriv0(): string {
  return HDNodeWallet.fromPhrase(HD_MASTER_MNEMONIC, undefined, "m/44'/195'/0'/0/0").privateKey
}
function tronAddr(priv: string): string {
  const pub = getBytes(SigningKey.computePublicKey(priv, false)).slice(1)
  const h = getBytes(keccak256(pub))
  const a = new Uint8Array(21); a[0] = 0x41; a.set(h.slice(-20), 1)
  const c = getBytes(eSha256(eSha256(a))).slice(0, 4)
  const f = new Uint8Array(25); f.set(a, 0); f.set(c, 21)
  return encodeBase58(f)
}
// base58 Tron addr → 0x-prefixed 20-byte EVM-style hex (for ABI).
function tron20(b58: string): string {
  let h = decodeBase58(b58).toString(16); if (h.length % 2) h = '0' + h
  const b = getBytes('0x' + h).slice(0, 21) // 0x41 + 20
  return '0x' + Array.from(b.slice(1)).map(x => x.toString(16).padStart(2, '0')).join('')
}
async function tronRpc(path: string, body: unknown): Promise<any> {
  const hd: Record<string, string> = { 'content-type': 'application/json' }
  if (NOWNODES_API_KEY) hd['api-key'] = NOWNODES_API_KEY
  const r = await fetch(TRON_API + path, { method: 'POST', headers: hd, body: JSON.stringify(body) })
  if (!r.ok) throw new Error(`tron ${path} ${r.status}`)
  return r.json()
}
function tronSign(tx: any, priv: string) {
  const s = new SigningKey(priv).sign('0x' + tx.txID)
  return { ...tx, signature: [s.r.slice(2) + s.s.slice(2) + (s.yParity ? '01' : '00')] }
}
// constant (read) contract call → raw hex result
async function tronConst(owner: string, contract: string, sel: string, paramHex: string): Promise<string> {
  const r = await tronRpc('/wallet/triggerconstantcontract', {
    owner_address: owner, contract_address: contract,
    function_selector: sel, parameter: paramHex, visible: true,
  })
  return r?.constant_result?.[0] || ''
}
// state-changing call: build → sign → broadcast. Returns txid.
async function tronCall(
  priv: string, owner: string, contract: string, sel: string,
  paramHex: string, callValueSun = 0,
): Promise<string> {
  const r0 = await tronRpc('/wallet/triggersmartcontract', {
    owner_address: owner, contract_address: contract,
    function_selector: sel, parameter: paramHex,
    fee_limit: TRON_FEE_LIMIT, call_value: callValueSun, visible: true,
  })
  const tx = r0?.transaction
  if (!tx?.txID) throw new Error('build failed: ' + JSON.stringify(r0).slice(0, 240))
  const r = await tronRpc('/wallet/broadcasttransaction', tronSign(tx, priv))
  if (r?.result !== true && !r?.txid) throw new Error('broadcast: ' + JSON.stringify(r).slice(0, 240))
  return tx.txID
}

// ── Highload Wallet V3 (inlined, identical to process-withdrawals) ──
const HIGHLOAD_V3_CODE_HEX = 'b5ee9c7241021001000228000114ff00f4a413f4bcf2c80b01020120020d02014803040078d020d74bc00101c060b0915be101d0d3030171b0915be0fa4030f828c705b39130e0d31f018210ae42e5a4ba9d8040d721d74cf82a01ed55fb04e030020120050a02027306070011adce76a2686b85ffc00201200809001aabb6ed44d0810122d721d70b3f0018aa3bed44d08307d721d70b1f0201200b0c001bb9a6eed44d0810162d721d70b15800e5b8bf2eda2edfb21ab09028409b0ed44d0810120d721f404f404d33fd315d1058e1bf82325a15210b99f326df82305aa0015a112b992306dde923033e2923033e25230800df40f6fa19ed021d721d70a00955f037fdb31e09130e259800df40f6fa19cd001d721d70a00937fdb31e0915be270801f6f2d48308d718d121f900ed44d0d3ffd31ff404f404d33fd315d1f82321a15220b98e12336df82324aa00a112b9926d32de58f82301de541675f910f2a106d0d31fd4d307d30cd309d33fd315d15168baf2a2515abaf2a6f8232aa15250bcf2a304f823bbf2a35304800df40f6fa199d024d721d70a00f2649130e20e01fe5309800df40f6fa18e13d05004d718d20001f264c858cf16cf8301cf168e1030c824cf40cf8384095005a1a514cf40e2f800c94039800df41704c8cbff13cb1ff40012f40012cb3f12cb15c9ed54f80f21d0d30001f265d3020171b0925f03e0fa4001d70b01c000f2a5fa4031fa0031f401fa0031fa00318060d721d300010f0020f265d2000193d431d19130e272b1fb00b585bf03'
const SUBWALLET_ID = 0x10ad
const TIMEOUT = 60 * 60 * 24
let queryShift = Math.floor(Date.now() / 1000) % 8191
let queryBitNumber = Math.floor(Math.random() * 1023)

function hexToBytes(hex: string): Uint8Array {
  const b = new Uint8Array(hex.length / 2)
  for (let i = 0; i < hex.length; i += 2) b[i / 2] = parseInt(hex.substr(i, 2), 16)
  return b
}
const getHighloadCode = () => Cell.fromBoc(hexToBytes(HIGHLOAD_V3_CODE_HEX))[0]
function buildInitData(pk: Uint8Array): Cell {
  return beginCell().storeBuffer(pk, 32).storeUint(SUBWALLET_ID, 32)
    .storeUint(0, 1).storeUint(0, 1).storeUint(0, 64).storeUint(TIMEOUT, 22).endCell()
}
const getWalletAddress = (pk: Uint8Array) =>
  contractAddress(0, { code: getHighloadCode(), data: buildInitData(pk) })
function nextQueryId() {
  const r = { shift: queryShift, bitNumber: queryBitNumber }
  if (++queryBitNumber >= 1023) { queryBitNumber = 0; if (++queryShift >= 8191) queryShift = 0 }
  return r
}

async function sendInternal(
  client: TonClient, secretKey: Uint8Array, publicKey: Uint8Array,
  to: Address, value: bigint, bodyCell: Cell | null,
) {
  const walletAddress = getWalletAddress(publicKey)
  const m = beginCell().storeUint(0x10, 6).storeAddress(to).storeCoins(value)
  if (bodyCell) {
    m.storeUint(0, 1 + 4 + 4 + 64 + 32).storeBit(false).storeBit(true).storeRef(bodyCell)
  } else {
    m.storeUint(0, 1 + 4 + 4 + 64 + 32 + 1 + 1)
  }
  const internalMsg = m.endCell()
  const qid = nextQueryId()
  const queryId = qid.shift * 1024 + qid.bitNumber
  const createdAt = Math.floor(Date.now() / 1000) - 10
  const mode = SendMode.PAY_GAS_SEPARATELY + SendMode.IGNORE_ERRORS
  const signingMessage = beginCell()
    .storeUint(SUBWALLET_ID, 32).storeRef(internalMsg).storeUint(mode, 8)
    .storeUint(queryId, 23).storeUint(createdAt, 64).storeUint(TIMEOUT, 22).endCell()
  const signature = sign(signingMessage.hash(), secretKey)
  const body = beginCell().storeBuffer(signature, 64).storeRef(signingMessage).endCell()
  const extMsg = beginCell()
    .storeUint(0b10, 2).storeUint(0, 2).storeAddress(walletAddress).storeCoins(0)
    .storeBit(false).storeBit(true).storeRef(body).endCell()
  await client.sendFile(extMsg.toBoc())
}

// STON.fi REST simulate (the SDK client dropped `units` → 400).
// POST with query string, no body — exactly how STON.fi expects.
// Returns { ask_units, min_ask_units, router_address, ... }.
async function stonSimulate(
  offerAddr: string, askAddr: string, unitsStr: string,
  slip: number, dexV2: boolean,
): Promise<any> {
  const qs = new URLSearchParams({
    offer_address: offerAddr,
    ask_address: askAddr,
    units: unitsStr,
    slippage_tolerance: String(slip),
  })
  if (dexV2) qs.set('dex_v2', 'true')
  const r = await fetch(`https://api.ston.fi/v1/swap/simulate?${qs.toString()}`, {
    method: 'POST', headers: { accept: 'application/json' },
  })
  if (!r.ok) {
    throw new Error(`ston simulate ${r.status}: ${(await r.text()).slice(0, 200)}`)
  }
  return r.json()
}

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } })

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  try {
    const { user_id, dir, amount, slippage } = await req.json().catch(() => ({}))
    if (!user_id || !dir || !(Number(amount) > 0)) return json({ error: 'bad_params' }, 400)
    const TON_DIRS = ['ton_to_usdt', 'usdt_to_ton']
    const TRX_DIRS = ['trx_to_usdt', 'usdt_to_trx']
    const EVM_DIRS = [
      'eth_to_usdt', 'usdt_to_eth', 'eth_to_usdc', 'usdc_to_eth',
      'bnb_to_usdt', 'usdt_to_bnb', 'bnb_to_usdc', 'usdc_to_bnb',
    ]
    if (![...TON_DIRS, ...TRX_DIRS, ...EVM_DIRS].includes(dir)) {
      return json({ error: 'bad_dir' }, 400)
    }

    const { data: u } = await sb.from('users')
      .select('telegram_id').eq('id', user_id).maybeSingle()
    if (!u || String(u.telegram_id) !== String(ADMIN_TG)) return json({ error: 'forbidden' }, 403)

    const slip = Number(slippage) > 0 ? Number(slippage) : 0.01

    // ── TRON / SunSwap V2 router (exactly what sunswap.com uses) ──
    // The live router is the Uniswap-V2-style one (selector
    // 0x7ff36ab5 = swapExactETHForTokens, WTRX as "ETH"). Quote
    // via getAmountsOut on the same router; no external API.
    if (TRX_DIRS.includes(dir)) {
      if (!HD_MASTER_MNEMONIC) return json({ error: 'no_hd_master' }, 500)
      const priv = tronPriv0()
      const owner = tronAddr(priv)
      const o20 = tron20(owner)
      const router20 = tron20(SUN_ROUTER)
      const W = tron20(WTRX), U = tron20(TRON_USDT)
      const deadline = Math.floor(Date.now() / 1000) + 600
      const isTrxIn = dir === 'trx_to_usdt'
      const path = isTrxIn ? [W, U] : [U, W]

      const inUnits = BigInt(Math.round(Number(amount) * 1e6))  // TRX & USDT 6dec

      // getAmountsOut(amountIn, path) → expected out (last element)
      const goP = abi.encode(['uint256', 'address[]'], [inUnits, path]).slice(2)
      const goRes = await tronConst(owner, SUN_ROUTER, 'getAmountsOut(uint256,address[])', goP)
      if (!goRes) throw new Error('getAmountsOut empty (router/pair?)')
      const [amounts] = abi.decode(['uint256[]'], '0x' + goRes)
      const outUnits = BigInt(amounts[amounts.length - 1])
      if (outUnits <= 0n) return json({ error: 'zero_out' }, 400)
      const minOut = (outUnits * BigInt(Math.floor((1 - slip) * 1e6))) / 1_000_000n

      let txid = ''
      if (isTrxIn) {
        // swapExactETHForTokens(amountOutMin, path, to, deadline) payable
        const p = abi.encode(
          ['uint256', 'address[]', 'address', 'uint256'],
          [minOut, path, o20, BigInt(deadline)],
        ).slice(2)
        txid = await tronCall(priv, owner, SUN_ROUTER,
          'swapExactETHForTokens(uint256,address[],address,uint256)',
          p, Number(inUnits))
      } else {
        // USDT→TRX needs allowance for the router.
        const alP = abi.encode(['address', 'address'], [o20, router20]).slice(2)
        const alRes = await tronConst(owner, TRON_USDT, 'allowance(address,address)', alP)
        const allowance = alRes ? BigInt('0x' + alRes) : 0n
        if (allowance < inUnits) {
          const MAX = (1n << 256n) - 1n
          const apP = abi.encode(['address', 'uint256'], [router20, MAX]).slice(2)
          const atx = await tronCall(priv, owner, TRON_USDT, 'approve(address,uint256)', apP, 0)
          await sb.rpc('admin_log', {
            p_level: 'info', p_source: 'edge:dex-swap',
            p_message: 'tron approved', p_details: { txid: atx, router: SUN_ROUTER },
          })
          return json({
            ok: true, dir, step: 'approved', txid: atx,
            note: 'USDT разрешён роутеру — повтори свап через ~10 сек',
          })
        }
        // swapExactTokensForETH(amountIn, amountOutMin, path, to, deadline)
        const p = abi.encode(
          ['uint256', 'uint256', 'address[]', 'address', 'uint256'],
          [inUnits, minOut, path, o20, BigInt(deadline)],
        ).slice(2)
        txid = await tronCall(priv, owner, SUN_ROUTER,
          'swapExactTokensForETH(uint256,uint256,address[],address,uint256)',
          p, 0)
      }

      await sb.rpc('admin_log', {
        p_level: 'info', p_source: 'edge:dex-swap',
        p_message: 'tron swap',
        p_details: {
          dir, amount: String(amount), slip, txid,
          exp: outUnits.toString(), min: minOut.toString(), router: SUN_ROUTER,
        },
      })
      return json({
        ok: true, dir, step: 'swap', txid,
        expected_out: outUnits.toString(), min_out: minOut.toString(),
        out_dec: 6, out_sym: isTrxIn ? 'USDT' : 'TRX',
      })
    }

    // ── EVM / Uniswap-V2-fork (ETH→Uniswap, BNB→PancakeSwap) ──
    // Treasury HD-0 wallet. ETH USDT/USDC = 6 dec, BSC = 18 dec.
    if (EVM_DIRS.includes(dir)) {
      if (!HD_MASTER_MNEMONIC) return json({ error: 'no_hd_master' }, 500)
      const chain = dir.includes('bnb') ? 'bnb' : 'eth'
      const cfg = EVM_CHAIN[chain]
      const w = evmTreasuryWallet(cfg.rpc)
      const me = await w.getAddress()
      const isNativeIn = dir.startsWith(`${chain}_to_`)
      const isUsdc = dir.includes('usdc')
      const token = isUsdc ? cfg.usdc : cfg.usdt
      const tokSym = isUsdc ? 'USDC' : 'USDT'
      const router = new Contract(cfg.router, UNI_ABI, w)
      const deadline = Math.floor(Date.now() / 1000) + 600
      const path = isNativeIn ? [cfg.weth, token] : [token, cfg.weth]
      const amountIn = isNativeIn
        ? parseEther(String(amount))                  // native 18 dec
        : parseUnits(String(amount), cfg.tokDec)      // USDT/USDC

      const amounts = await router.getAmountsOut(amountIn, path)
      const outUnits: bigint = amounts[amounts.length - 1]
      if (outUnits <= 0n) return json({ error: 'zero_out' }, 400)
      const minOut = (outUnits * BigInt(Math.floor((1 - slip) * 1e6))) / 1_000_000n

      let txid = ''
      if (isNativeIn) {
        const tx = await router.swapExactETHForTokens(
          minOut, path, me, deadline, { value: amountIn })
        txid = tx.hash
      } else {
        const erc = new Contract(token, ERC20_ABI, w)
        const allow: bigint = await erc.allowance(me, cfg.router)
        if (allow < amountIn) {
          const atx = await erc.approve(cfg.router, MaxUint256)
          await sb.rpc('admin_log', {
            p_level: 'info', p_source: 'edge:dex-swap',
            p_message: 'evm approved', p_details: { chain, txid: atx.hash, token, router: cfg.router },
          })
          return json({
            ok: true, dir, step: 'approved', txid: atx.hash,
            note: `${tokSym} разрешён роутеру — повтори свап через ~20 сек`,
          })
        }
        const tx = await router.swapExactTokensForETH(
          amountIn, minOut, path, me, deadline)
        txid = tx.hash
      }

      await sb.rpc('admin_log', {
        p_level: 'info', p_source: 'edge:dex-swap',
        p_message: 'evm swap',
        p_details: {
          chain, dir, amount: String(amount), slip, txid,
          exp: outUnits.toString(), min: minOut.toString(), router: cfg.router,
        },
      })
      return json({
        ok: true, dir, step: 'swap', txid,
        expected_out: outUnits.toString(), min_out: minOut.toString(),
        out_dec: isNativeIn ? cfg.tokDec : 18,
        out_sym: isNativeIn ? tokSym : cfg.native,
      })
    }

    // ── TON / STON.fi (Highload wallet) ──
    if (!WALLET_TON_MNEMONIC) return json({ error: 'no_ton_mnemonic' }, 500)
    const kp = await mnemonicToPrivateKey(WALLET_TON_MNEMONIC.split(' '))
    const walletAddr = getWalletAddress(kp.publicKey)
    const client = new TonClient({ endpoint: TONCENTER_ENDPOINT, apiKey: TONCENTER_API_KEY })

    // STON.fi routers. We FIRST simulate to learn which router/
    // pool the route actually goes through, then build the tx with
    // THAT exact router (picking an arbitrary one made the on-chain
    // swap bounce — "Failed").
    const api = new StonApiClient()
    const routers = await api.getRouters()
    if (!routers || routers.length === 0) return json({ error: 'no_router' }, 502)
    const sameAddr = (a: string, b: string) => {
      try { return Address.parse(a).equals(Address.parse(b)) } catch { return a === b }
    }
    // A candidate just to get a pTON master for the simulate call.
    const cand = [...routers].sort(
      (a: any, b: any) => (b.majorVersion ?? 0) - (a.majorVersion ?? 0))[0]
    const dexV2 = Number(cand.majorVersion ?? 1) >= 2
    const minOut = (q: any) =>
      BigInt(q.min_ask_units ?? q.minAskUnits ?? q.min_out ?? 0)

    let params: { to: Address; value: bigint; body: Cell }
    let quote: any

    if (dir === 'ton_to_usdt') {
      const offerNano = toNano(String(amount))                 // TON, 9 dec
      quote = await stonSimulate(
        cand.ptonMasterAddress, USDT_MASTER,
        offerNano.toString(), slip, dexV2,
      )
      const chosen = routers.find((r: any) =>
        quote.router_address && sameAddr(r.address, quote.router_address)) || cand
      const dex = dexFactory(chosen)
      const router = client.open(dex.Router.create(chosen.address))
      const proxyTon = dex.pTON.create(chosen.ptonMasterAddress)
      params = await router.getSwapTonToJettonTxParams({
        userWalletAddress: walletAddr,
        proxyTon,
        offerAmount: offerNano,
        askJettonAddress: USDT_MASTER,
        minAskAmount: minOut(quote),
        queryId: nextQueryId().shift,
      })
    } else {
      const offerUnits = BigInt(Math.round(Number(amount) * 1e6)) // USDT, 6 dec
      quote = await stonSimulate(
        USDT_MASTER, cand.ptonMasterAddress,
        offerUnits.toString(), slip, dexV2,
      )
      const chosen = routers.find((r: any) =>
        quote.router_address && sameAddr(r.address, quote.router_address)) || cand
      const dex = dexFactory(chosen)
      const router = client.open(dex.Router.create(chosen.address))
      const proxyTon = dex.pTON.create(chosen.ptonMasterAddress)
      params = await router.getSwapJettonToTonTxParams({
        userWalletAddress: walletAddr,
        proxyTon,
        offerJettonAddress: USDT_MASTER,
        offerAmount: offerUnits,
        minAskAmount: minOut(quote),
        queryId: nextQueryId().shift,
      })
    }

    await sendInternal(
      client, kp.secretKey, kp.publicKey,
      Address.isAddress(params.to) ? params.to : Address.parse(String(params.to)),
      BigInt(params.value), params.body,
    )

    await sb.rpc('admin_log', {
      p_level: 'info', p_source: 'edge:dex-swap',
      p_message: 'swap sent',
      p_details: {
        dir, amount: String(amount), slip,
        expect_out: quote?.ask_units ?? quote?.askUnits,
        min_out: quote?.min_ask_units ?? quote?.minAskUnits,
        router: quote?.router_address, pool: quote?.pool_address,
      },
    })
    return json({
      ok: true, dir,
      expected_out: quote?.ask_units ?? quote?.askUnits ?? null,
      min_out: quote?.min_ask_units ?? quote?.minAskUnits ?? null,
    })
  } catch (e) {
    try {
      await sb.rpc('admin_log', {
        p_level: 'error', p_source: 'edge:dex-swap',
        p_message: 'failed', p_details: { err: String(e).slice(0, 500) },
      })
    } catch { /* noop */ }
    return json({ error: 'swap_failed', detail: String(e).slice(0, 300) }, 500)
  }
})

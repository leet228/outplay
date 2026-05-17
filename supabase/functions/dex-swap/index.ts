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

const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const WALLET_TON_MNEMONIC  = Deno.env.get('WALLET_TON_MNEMONIC')!
const TONCENTER_API_KEY    = Deno.env.get('TONCENTER_API_KEY') || undefined
const ADMIN_TG             = Deno.env.get('ADMIN_TG_ID') || '945676433'

const USDT_MASTER = 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs'
const TONCENTER_ENDPOINT = 'https://toncenter.com/api/v2/jsonRPC'

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
    if (!WALLET_TON_MNEMONIC) return json({ error: 'no_ton_mnemonic' }, 500)
    const { user_id, dir, amount, slippage } = await req.json().catch(() => ({}))
    if (!user_id || !dir || !(Number(amount) > 0)) return json({ error: 'bad_params' }, 400)
    if (dir !== 'ton_to_usdt' && dir !== 'usdt_to_ton') return json({ error: 'bad_dir' }, 400)

    const { data: u } = await sb.from('users')
      .select('telegram_id').eq('id', user_id).maybeSingle()
    if (!u || String(u.telegram_id) !== String(ADMIN_TG)) return json({ error: 'forbidden' }, 403)

    const slip = Number(slippage) > 0 ? Number(slippage) : 0.01
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

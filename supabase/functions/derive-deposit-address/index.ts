// ╔══════════════════════════════════════════════════════════════╗
// ║  derive-deposit-address — per-user HD deposit wallets        ║
// ╚══════════════════════════════════════════════════════════════╝
//
// Idempotent. Given { user_id } it:
//   1. claim_user_deposit_index(user_id)  → reserves/returns the
//      user's permanent BIP44 child index (DB owns allocation).
//   2. if already `ready` → returns the stored addresses.
//   3. else derives the 4 addresses for that index from the ONE
//      HD master (env HD_MASTER_MNEMONIC) and persists them via
//      set_user_deposit_addresses (service-role, immutable once
//      set so they keep matching on-chain history).
//
// The master mnemonic lives ONLY as the HD_MASTER_MNEMONIC Edge
// secret — never in the DB, bundle, or git. Only public addresses
// are stored/returned; private keys are re-derived on demand by
// the (future) sweep function from the same master + index.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { deriveForIndex } from '../_shared/hd.ts'

const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const HD_MASTER_MNEMONIC   = Deno.env.get('HD_MASTER_MNEMONIC') || ''

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

  try {
    if (!HD_MASTER_MNEMONIC) {
      return json({ error: 'hd_master_not_configured' }, 500)
    }

    const { user_id } = await req.json().catch(() => ({}))
    if (!user_id || typeof user_id !== 'string') {
      return json({ error: 'missing_user_id' }, 400)
    }

    // 1. Reserve / fetch the user's derivation index.
    const { data: claim, error: claimErr } = await supabase.rpc(
      'claim_user_deposit_index', { p_user_id: user_id },
    )
    if (claimErr || !claim || claim.error) {
      await supabase.rpc('admin_log', {
        p_level: 'error',
        p_source: 'edge:derive-deposit-address',
        p_message: 'claim_user_deposit_index failed',
        p_details: { user_id, err: claimErr?.message || claim?.error },
      })
      return json({ error: 'claim_failed' }, 500)
    }

    // 2. Already provisioned → hand back the stored addresses.
    if (claim.ready) {
      return json({
        ok: true,
        ready: true,
        addresses: {
          evm: claim.evm, tron: claim.tron,
          btc: claim.btc, ltc: claim.ltc,
        },
      })
    }

    // 3. Derive for this index + persist (immutable once set).
    const idx = Number(claim.index)
    if (!Number.isInteger(idx) || idx < 0) {
      return json({ error: 'bad_index' }, 500)
    }
    const a = deriveForIndex(HD_MASTER_MNEMONIC, idx)

    const { data: setRes, error: setErr } = await supabase.rpc(
      'set_user_deposit_addresses',
      {
        p_user_id: user_id,
        p_evm: a.evm, p_tron: a.tron, p_btc: a.btc, p_ltc: a.ltc,
      },
    )
    if (setErr || !setRes || setRes.error) {
      await supabase.rpc('admin_log', {
        p_level: 'error',
        p_source: 'edge:derive-deposit-address',
        p_message: 'set_user_deposit_addresses failed',
        p_details: { user_id, idx, err: setErr?.message || setRes?.error },
      })
      return json({ error: 'persist_failed' }, 500)
    }

    return json({
      ok: true,
      ready: true,
      addresses: { evm: a.evm, tron: a.tron, btc: a.btc, ltc: a.ltc },
    })
  } catch (e) {
    try {
      await supabase.rpc('admin_log', {
        p_level: 'error',
        p_source: 'edge:derive-deposit-address',
        p_message: 'unhandled',
        p_details: { err: String(e) },
      })
    } catch { /* best-effort */ }
    return json({ error: 'internal' }, 500)
  }
})

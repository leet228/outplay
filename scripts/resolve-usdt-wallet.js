// =============================================================
// Resolve OUR USDT jetton-wallet address.
//
// Every Jetton holder has a deterministic sub-contract (the
// "jetton-wallet") derived from:
//   - the holder's main TON address (our highload), and
//   - the jetton-master contract address (USDT on TON).
//
// This script:
//   1. Asks the USDT master contract for our jetton-wallet
//      address (via get-method `get_wallet_address`), which is
//      the canonical pure on-chain way.
//   2. Tries to read the actual jetton balance on that wallet.
//      If the wallet isn't deployed yet (= we've never received
//      USDT), the address is still valid — the wallet will
//      auto-deploy on the first incoming jetton transfer.
//
// Run:
//   cd scripts && npm i  (if you haven't already)
//   node resolve-usdt-wallet.js
//
// Output: prints the jetton-wallet address. Save that string
// into supabase/migrations/<new>.sql as USDT_JETTON_WALLET when
// you set up the indexer.
// =============================================================

import { Address } from '@ton/core'

// Our public highload wallet address (the one shown to the
// user in the deposit UI).
const TON_ADDRESS = 'UQDsqlvskoZupLe-DFTwffYIqMIXxq6ghYSqh_PjIfOHz_bC'

// Official USDT (Tether) master on TON.
//   https://tonviewer.com/EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs
const USDT_MASTER  = 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs'

// TonCenter v3 has a dedicated /jetton/wallets endpoint that
// avoids running a get-method on-chain — much friendlier with
// rate-limits and works through any local HTTPS proxy.
async function fetchViaV3() {
  const url = new URL('https://toncenter.com/api/v3/jetton/wallets')
  url.searchParams.set('owner_address', TON_ADDRESS)
  url.searchParams.set('jetton_address', USDT_MASTER)
  url.searchParams.set('limit', '1')

  const res = await fetch(url)
  if (!res.ok) throw new Error(`TonCenter v3 HTTP ${res.status}`)
  const data = await res.json()
  const w = data?.jetton_wallets?.[0]
  if (!w?.address) return null
  return {
    rawAddress:  w.address,
    balance:     w.balance ?? '0',
    deployed:    Boolean(w.address),
  }
}

async function main() {
  console.log('Querying TonCenter v3 for USDT jetton-wallet…')

  let info = null
  try {
    info = await fetchViaV3()
  } catch (err) {
    console.error('v3 query failed:', err.message || err)
    process.exit(1)
  }

  if (!info) {
    // Wallet not indexed yet — most likely because no USDT was
    // ever received. The address is still deterministic; once
    // you send any USDT to our main TON_ADDRESS the jetton-
    // wallet will auto-deploy and TonCenter will index it.
    console.log('')
    console.log('═'.repeat(64))
    console.log('  ⚠ Jetton-wallet NOT yet indexed by TonCenter.')
    console.log('')
    console.log('  This means we have never received USDT — the wallet')
    console.log('  has not been auto-deployed yet.')
    console.log('')
    console.log('  TO PRE-DEPLOY:')
    console.log('    Send ANY amount of USDT (e.g. 1 USDT) on the TON')
    console.log('    network to your highload wallet address:')
    console.log('')
    console.log('       ', TON_ADDRESS)
    console.log('')
    console.log('    From Tonkeeper / Bybit (TON withdraw) / MyTonWallet.')
    console.log('    A jetton-wallet sub-contract will auto-deploy on')
    console.log('    receipt. Then re-run this script.')
    console.log('═'.repeat(64))
    return
  }

  const addr = Address.parse(info.rawAddress)
  const usdt = Number(info.balance) / 1e6

  console.log('')
  console.log('═'.repeat(64))
  console.log('  USDT jetton-wallet for highload', TON_ADDRESS)
  console.log('═'.repeat(64))
  console.log('  Bounceable (EQ…):', addr.toString({ bounceable: true,  testOnly: false }))
  console.log('  Friendly  (UQ…):',  addr.toString({ bounceable: false, testOnly: false }))
  console.log('  Raw       (0:hex):', addr.toRawString())
  console.log(`  Current USDT balance: ${usdt.toFixed(6)} USDT`)
  console.log('  ✅ DEPLOYED — indexer can start polling it.')
  console.log('═'.repeat(64))
}

main().catch(err => {
  console.error('Error:', err)
  process.exit(1)
})

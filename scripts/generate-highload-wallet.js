/**
 * Generate a new Highload Wallet V3 address and mnemonic.
 *
 * Usage:
 *   node scripts/generate-highload-wallet.js
 *
 * Output:
 *   - 24-word mnemonic (save this as WALLET_TON_MNEMONIC env var)
 *   - Wallet address (update in src/lib/addresses.js)
 *
 * The wallet auto-deploys on the first external message (first sendBatch).
 * Just send some TON to the address and it will activate on first withdrawal.
 */

import { mnemonicNew, mnemonicToPrivateKey } from '@ton/crypto'
import { HighloadWalletV3 } from '@tonkite/highload-wallet-v3'
import { TonClient } from '@ton/ton'

async function main() {
  // Generate new 24-word mnemonic
  const mnemonic = await mnemonicNew(24)
  const keyPair = await mnemonicToPrivateKey(mnemonic)

  // Create wallet instance to get address
  const client = new TonClient({ endpoint: 'https://toncenter.com/api/v2/jsonRPC' })
  const queryIdSequence = HighloadWalletV3.newSequence()
  const wallet = client.open(new HighloadWalletV3(queryIdSequence, keyPair.publicKey))

  const addressBounceable = wallet.address.toString({ bounceable: true, testOnly: false })
  const addressNonBounceable = wallet.address.toString({ bounceable: false, testOnly: false })

  console.log('\n════════════════════════════════════════')
  console.log('  HIGHLOAD WALLET V3 — GENERATED')
  console.log('════════════════════════════════════════\n')
  console.log('Mnemonic (24 words):')
  console.log(mnemonic.join(' '))
  console.log('\nAddress (bounceable):')
  console.log(addressBounceable)
  console.log('\nAddress (non-bounceable, for deposits):')
  console.log(addressNonBounceable)
  console.log('\n════════════════════════════════════════')
  console.log('\nNext steps:')
  console.log('1. Save mnemonic as WALLET_TON_MNEMONIC in Supabase Edge Function secrets')
  console.log('2. Update src/lib/addresses.js with the non-bounceable address')
  console.log('3. Send some TON to the address (it auto-deploys on first use)')
  console.log('4. Deploy the updated Edge Function')
  console.log('════════════════════════════════════════\n')
}

main().catch(console.error)

/**
 * Generate a new Highload Wallet V3 address and mnemonic.
 * Uses official contract code from ton-blockchain/highload-wallet-contract-v3
 *
 * Usage:
 *   node scripts/generate-highload-wallet.js
 */

import { mnemonicNew, mnemonicToPrivateKey } from '@ton/crypto'
import { Cell, beginCell, contractAddress } from '@ton/core'

const HIGHLOAD_V3_CODE_HEX = 'b5ee9c7241021001000228000114ff00f4a413f4bcf2c80b01020120020d02014803040078d020d74bc00101c060b0915be101d0d3030171b0915be0fa4030f828c705b39130e0d31f018210ae42e5a4ba9d8040d721d74cf82a01ed55fb04e030020120050a02027306070011adce76a2686b85ffc00201200809001aabb6ed44d0810122d721d70b3f0018aa3bed44d08307d721d70b1f0201200b0c001bb9a6eed44d0810162d721d70b15800e5b8bf2eda2edfb21ab09028409b0ed44d0810120d721f404f404d33fd315d1058e1bf82325a15210b99f326df82305aa0015a112b992306dde923033e2923033e25230800df40f6fa19ed021d721d70a00955f037fdb31e09130e259800df40f6fa19cd001d721d70a00937fdb31e0915be270801f6f2d48308d718d121f900ed44d0d3ffd31ff404f404d33fd315d1f82321a15220b98e12336df82324aa00a112b9926d32de58f82301de541675f910f2a106d0d31fd4d307d30cd309d33fd315d15168baf2a2515abaf2a6f8232aa15250bcf2a304f823bbf2a35304800df40f6fa199d024d721d70a00f2649130e20e01fe5309800df40f6fa18e13d05004d718d20001f264c858cf16cf8301cf168e1030c824cf40cf8384095005a1a514cf40e2f800c94039800df41704c8cbff13cb1ff40012f40012cb3f12cb15c9ed54f80f21d0d30001f265d3020171b0925f03e0fa4001d70b01c000f2a5fa4031fa0031f401fa0031fa00318060d721d300010f0020f265d2000193d431d19130e272b1fb00b585bf03'

const SUBWALLET_ID = 0x10ad
const TIMEOUT = 60 * 60 // 1 hour

async function main() {
  const mnemonic = await mnemonicNew(24)
  const keyPair = await mnemonicToPrivateKey(mnemonic)

  const code = Cell.fromBoc(Buffer.from(HIGHLOAD_V3_CODE_HEX, 'hex'))[0]
  const data = beginCell()
    .storeBuffer(keyPair.publicKey, 32)
    .storeUint(SUBWALLET_ID, 32)
    .storeUint(0, 1)
    .storeUint(0, 1)
    .storeUint(0, 64)
    .storeUint(TIMEOUT, 22)
    .endCell()

  const address = contractAddress(0, { code, data })

  console.log('\n════════════════════════════════════════')
  console.log('  HIGHLOAD WALLET V3 — GENERATED')
  console.log('════════════════════════════════════════\n')
  console.log('Mnemonic (24 words):')
  console.log(mnemonic.join(' '))
  console.log('\nAddress (bounceable):')
  console.log(address.toString({ bounceable: true, testOnly: false }))
  console.log('\nAddress (non-bounceable, for deposits):')
  console.log(address.toString({ bounceable: false, testOnly: false }))
  console.log('\nParams: subwalletId=0x10ad, timeout=3600')
  console.log('\n════════════════════════════════════════')
  console.log('Save mnemonic → WALLET_TON_MNEMONIC env')
  console.log('Update address → src/lib/addresses.js')
  console.log('Send TON → auto-deploys on first use')
  console.log('════════════════════════════════════════\n')
}

main().catch(console.error)

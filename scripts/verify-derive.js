/**
 * verify-derive.js — proves the LIGHTWEIGHT derivation (ethers +
 * bech32 only, exactly what the Deno Edge Function will run) gives
 * byte-identical addresses to the heavyweight reference in
 * hd-derive.js (tronweb + bitcoinjs-lib).
 *
 * If this passes, the Edge Function — which can't easily run
 * tronweb/bitcoinjs in Deno — can safely use the pure ethers path,
 * because a single wrong char = deposits to an address whose key
 * we can't re-derive = unrecoverable funds.
 *
 *   cd scripts && node verify-derive.js
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  HDNodeWallet, SigningKey, keccak256, sha256, ripemd160,
  encodeBase58, getBytes,
} from 'ethers'
import { bech32 } from 'bech32'
import { deriveForIndex as referenceDerive } from './hd-derive.js'

const HERE = dirname(fileURLToPath(import.meta.url))

// ── Candidate: pure ethers + bech32 (mirrors the Edge module) ──
function tronAddress(privateKey) {
  const pub = getBytes(SigningKey.computePublicKey(privateKey, false)).slice(1) // drop 0x04
  const hash = getBytes(keccak256(pub))
  const a21 = new Uint8Array(21)
  a21[0] = 0x41
  a21.set(hash.slice(-20), 1)
  const chk = getBytes(sha256(sha256(a21))).slice(0, 4)
  const full = new Uint8Array(25)
  full.set(a21, 0)
  full.set(chk, 21)
  return encodeBase58(full)
}

function segwitAddress(privateKey, hrp) {
  const pub = getBytes(SigningKey.computePublicKey(privateKey, true)) // compressed 33
  const h160 = getBytes(ripemd160(sha256(pub)))
  return bech32.encode(hrp, [0, ...bech32.toWords(h160)])
}

function candidateDerive(mnemonic, i) {
  const evm  = HDNodeWallet.fromPhrase(mnemonic, undefined, `m/44'/60'/0'/0/${i}`)
  const tron = HDNodeWallet.fromPhrase(mnemonic, undefined, `m/44'/195'/0'/0/${i}`)
  const btc  = HDNodeWallet.fromPhrase(mnemonic, undefined, `m/84'/0'/0'/0/${i}`)
  const ltc  = HDNodeWallet.fromPhrase(mnemonic, undefined, `m/84'/2'/0'/0/${i}`)
  return {
    evm: evm.address,
    tron: tronAddress(tron.privateKey),
    btc: segwitAddress(btc.privateKey, 'bc'),
    ltc: segwitAddress(ltc.privateKey, 'ltc'),
  }
}

const blob = JSON.parse(readFileSync(join(HERE, '.wallets.secret.json'), 'utf8'))
const mnemonic = blob.hdMnemonic
if (!mnemonic) { console.error('no hdMnemonic — run hd-derive.js first'); process.exit(1) }

let allOk = true
for (let i = 0; i <= 3; i++) {
  const ref = referenceDerive(mnemonic, i)   // tronweb + bitcoinjs
  const cand = candidateDerive(mnemonic, i)  // pure ethers + bech32
  for (const k of ['evm', 'tron', 'btc', 'ltc']) {
    const ok = ref[k] === cand[k]
    if (!ok) allOk = false
    console.log(`idx ${i} ${k.padEnd(4)} ${ok ? 'OK ' : 'MISMATCH'}  ${cand[k]}`)
    if (!ok) console.log(`           ref: ${ref[k]}`)
  }
}
console.log(allOk
  ? '\n✅ ALL MATCH — Edge can safely use the pure ethers path.'
  : '\n❌ MISMATCH — do NOT ship the Edge derivation.')
process.exit(allOk ? 0 : 1)

// Deterministic HD deposit-address derivation — the SERVER copy.
//
// Byte-identical to scripts/hd-derive.js (verified by
// scripts/verify-derive.js across indices 0..3, all 4 chains).
// Pure ethers + bech32 only — no tronweb / bitcoinjs / wasm — so
// it runs cleanly in the Deno Edge runtime. A single wrong char
// here = deposits to an address whose key we can't re-derive =
// unrecoverable funds, hence the cross-check gate before shipping.
//
// One EVM key (m/44'/60') = same 0x address on Ethereum AND BSC,
// so 4 derived addresses back all 10 deposit cards:
//   EVM   m/44'/60'/0'/0/{i}   → ETH + BSC + USDT/USDC ERC20/BEP20
//   TRON  m/44'/195'/0'/0/{i}  → TRX + USDT-TRC20
//   BTC   m/84'/0'/0'/0/{i}    → bc1…
//   LTC   m/84'/2'/0'/0/{i}    → ltc1…

import {
  HDNodeWallet, SigningKey, keccak256, sha256, ripemd160,
  encodeBase58, getBytes,
} from 'https://esm.sh/ethers@6.13.4'
import { bech32 } from 'https://esm.sh/bech32@2.0.0'

export interface DerivedAddresses {
  evm: string
  tron: string
  btc: string
  ltc: string
}

function tronAddress(privateKey: string): string {
  // uncompressed pubkey (drop the 0x04 prefix byte) → keccak256 →
  // last 20 bytes, prefixed 0x41, base58check (double-sha256).
  const pub = getBytes(SigningKey.computePublicKey(privateKey, false)).slice(1)
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

function segwitAddress(privateKey: string, hrp: string): string {
  const pub = getBytes(SigningKey.computePublicKey(privateKey, true)) // compressed 33
  const h160 = getBytes(ripemd160(sha256(pub)))
  return bech32.encode(hrp, [0, ...bech32.toWords(h160)])
}

export function deriveForIndex(mnemonic: string, i: number): DerivedAddresses {
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

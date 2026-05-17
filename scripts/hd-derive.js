/**
 * hd-derive.js — HD master + per-user deposit-address derivation.
 *
 * THE FOUNDATION of the deposit→sweep system: one master mnemonic
 * → a deterministic, unique address PER USER PER CHAIN. The same
 * code runs here (to generate / sanity-check) and later inside the
 * derive-deposit-address Edge Function (same paths → same
 * addresses, so the server can always re-derive a user's wallet
 * and its private key for sweeping — nothing per-user is stored
 * secret, only the ONE master is).
 *
 * One EVM key already covers Ethereum + BSC (same 0x address), so
 * a user gets exactly 4 addresses (EVM / TRON / BTC / LTC) which
 * back all 10 deposit cards.
 *
 * Usage:
 *   cd scripts && npm install
 *   node hd-derive.js              # generate master (first run) +
 *                                  # print index 0 sample
 *   node hd-derive.js 7            # print the addresses for user
 *                                  # derivation index 7
 *
 * Secrets: the master mnemonic is written to / read from
 *   scripts/.wallets.secret.json  (key "hdMnemonic", gitignored).
 * NEVER commit it. For prod, set the SAME phrase as the Supabase
 * Edge secret HD_MASTER_MNEMONIC.
 *
 * BIP44 paths (purpose 84 = native segwit where it applies):
 *   EVM   m/44'/60'/0'/0/{i}     → 0x… (ETH + BSC + tokens)
 *   TRON  m/44'/195'/0'/0/{i}    → T…  (TRX + USDT-TRC20)
 *   BTC   m/84'/0'/0'/0/{i}      → bc1…
 *   LTC   m/84'/2'/0'/0/{i}      → ltc1…
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { ethers } from 'ethers'
import { TronWeb } from 'tronweb'
import * as bitcoin from 'bitcoinjs-lib'
import { ECPairFactory } from 'ecpair'
import * as ecc from 'tiny-secp256k1'

const ECPair = ECPairFactory(ecc)
const HERE = dirname(fileURLToPath(import.meta.url))
const SECRET_PATH = join(HERE, '.wallets.secret.json')

const LITECOIN = {
  messagePrefix: '\x19Litecoin Signed Message:\n',
  bech32: 'ltc',
  bip32: { public: 0x019da462, private: 0x019d9cfe },
  pubKeyHash: 0x30,
  scriptHash: 0x32,
  wif: 0xb0,
}

// ── Master mnemonic: load, or generate + persist once ──
function loadOrCreateMnemonic() {
  let blob = {}
  if (existsSync(SECRET_PATH)) {
    try { blob = JSON.parse(readFileSync(SECRET_PATH, 'utf8')) } catch { blob = {} }
  }
  if (typeof blob.hdMnemonic === 'string' && blob.hdMnemonic.split(' ').length >= 12) {
    return { mnemonic: blob.hdMnemonic, created: false }
  }
  // 24-word (256-bit) BIP39 phrase via ethers' CSPRNG.
  const phrase = ethers.Mnemonic.fromEntropy(ethers.randomBytes(32)).phrase
  blob.hdMnemonic = phrase
  blob.hdMnemonicNote =
    'Set this SAME phrase as Supabase Edge secret HD_MASTER_MNEMONIC. ' +
    'Back it up — every user deposit address derives from it.'
  writeFileSync(SECRET_PATH, JSON.stringify(blob, null, 2), { mode: 0o600 })
  return { mnemonic: phrase, created: true }
}

// privateKey (0x hex) at a BIP44 path for the given mnemonic.
function privAt(mnemonic, path) {
  return ethers.HDNodeWallet.fromPhrase(mnemonic, undefined, path).privateKey
}

function evmAddr(mnemonic, i) {
  return ethers.HDNodeWallet
    .fromPhrase(mnemonic, undefined, `m/44'/60'/0'/0/${i}`)
    .address
}

function tronAddr(mnemonic, i) {
  const pk = privAt(mnemonic, `m/44'/195'/0'/0/${i}`).slice(2)
  return TronWeb.address.fromPrivateKey(pk)
}

function p2wpkhFromPriv(privHex, network) {
  const kp = ECPair.fromPrivateKey(Buffer.from(privHex.slice(2), 'hex'), { network })
  return bitcoin.payments.p2wpkh({ pubkey: Buffer.from(kp.publicKey), network }).address
}

function btcAddr(mnemonic, i) {
  return p2wpkhFromPriv(privAt(mnemonic, `m/84'/0'/0'/0/${i}`), bitcoin.networks.bitcoin)
}

function ltcAddr(mnemonic, i) {
  return p2wpkhFromPriv(privAt(mnemonic, `m/84'/2'/0'/0/${i}`), LITECOIN)
}

// Public surface: every address for a user's derivation index.
export function deriveForIndex(mnemonic, i) {
  return {
    index: i,
    evm: evmAddr(mnemonic, i),   // ETH + BSC + USDT/USDC ERC20/BEP20
    tron: tronAddr(mnemonic, i), // TRX + USDT-TRC20
    btc: btcAddr(mnemonic, i),
    ltc: ltcAddr(mnemonic, i),
  }
}

function main() {
  const { mnemonic, created } = loadOrCreateMnemonic()
  const idx = Number.parseInt(process.argv[2] ?? '0', 10) || 0

  if (created) {
    console.log('\n🆕 HD master mnemonic generated & saved to')
    console.log(`   ${SECRET_PATH}  (gitignored — BACK IT UP)`)
    console.log('   → set the SAME phrase as Supabase secret HD_MASTER_MNEMONIC\n')
  } else {
    console.log('\n🔑 Using existing HD master from .wallets.secret.json\n')
  }

  const d = deriveForIndex(mnemonic, idx)
  console.log(`═══ Deposit addresses for derivation index ${idx} ═══`)
  console.log(`  EVM  (ETH/BSC + USDT/USDC): ${d.evm}`)
  console.log(`  TRON (TRX + USDT-TRC20):    ${d.tron}`)
  console.log(`  BTC:                        ${d.btc}`)
  console.log(`  LTC:                        ${d.ltc}`)
  console.log('\n(Public addresses only — private keys never printed.)\n')
}

// Run as CLI; stay importable for the future Edge derivation.
if (process.argv[1] && process.argv[1].endsWith('hd-derive.js')) main()

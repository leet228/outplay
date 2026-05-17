/**
 * generate-wallets.js — one-time generator for the multi-chain
 * deposit wallets (the NEW chains only; TON / USDT-TON keep the
 * existing Highload-V3 wallet in src/lib/addresses.js).
 *
 * Usage:
 *   cd scripts
 *   npm install            # if not already
 *   node generate-wallets.js
 *
 * It writes ALL secrets (private keys / WIF) to
 *   scripts/.wallets.secret.json   ← gitignored, NEVER committed
 * and prints ONLY the public addresses + the app_settings keys to
 * paste in Admin → Control → "Кошельки пополнения".
 *
 * ⚠️  BACK UP scripts/.wallets.secret.json SOMEWHERE SAFE.
 *     The private keys CANNOT be recovered if lost — every coin
 *     ever deposited to these addresses would be unspendable.
 *
 * Key fact (why only 4 wallets cover 10 cards):
 *   • 1 TRON key  → TRX  +  USDT-TRC20
 *   • 1 EVM key   → same 0x address on Ethereum AND BSC, so it
 *                   covers ETH, USDT-ERC20, USDC-ERC20,
 *                   BNB, USDT-BEP20, USDC-BEP20
 *   • 1 BTC key   → BTC
 *   • 1 LTC key   → LTC
 */

import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { TronWeb } from 'tronweb'
import * as bitcoin from 'bitcoinjs-lib'
import { ECPairFactory } from 'ecpair'
import * as ecc from 'tiny-secp256k1'
import { ethers } from 'ethers'

const ECPair = ECPairFactory(ecc)
const HERE = dirname(fileURLToPath(import.meta.url))

// Litecoin network params (bitcoinjs-lib ships only Bitcoin).
const LITECOIN = {
  messagePrefix: '\x19Litecoin Signed Message:\n',
  bech32: 'ltc',
  bip32: { public: 0x019da462, private: 0x019d9cfe },
  pubKeyHash: 0x30,
  scriptHash: 0x32,
  wif: 0xb0,
}

// ── TRON (TRX + USDT-TRC20) ──────────────────────────
async function generateTron() {
  const tw = new TronWeb({ fullHost: 'https://api.trongrid.io' })
  const a = await tw.createAccount()
  return { chain: 'TRON', address: a.address.base58, privateKey: a.privateKey }
}

// ── EVM (Ethereum + BSC: same address on both) ───────
function generateEvm() {
  const w = ethers.Wallet.createRandom()
  return {
    chain: 'EVM',
    address: w.address,
    privateKey: w.privateKey,
    mnemonic: w.mnemonic?.phrase || null,
  }
}

// ── Bitcoin (native segwit bc1…) ─────────────────────
function generateBtc() {
  const kp = ECPair.makeRandom()
  const { address } = bitcoin.payments.p2wpkh({ pubkey: Buffer.from(kp.publicKey) })
  return { chain: 'BTC', address, privateKey: kp.toWIF() }
}

// ── Litecoin (native segwit ltc1…) ───────────────────
function generateLtc() {
  const kp = ECPair.makeRandom()
  const { address } = bitcoin.payments.p2wpkh({
    pubkey: Buffer.from(kp.publicKey),
    network: LITECOIN,
  })
  return { chain: 'LTC', address, privateKey: kp.toWIF(LITECOIN) }
}

// Which app_settings keys each wallet address fills.
const KEY_MAP = {
  TRON: ['deposit_addr_trx', 'deposit_addr_usdt_trc20'],
  EVM: [
    'deposit_addr_eth', 'deposit_addr_usdt_erc20', 'deposit_addr_usdc_erc20',
    'deposit_addr_bnb', 'deposit_addr_usdt_bep20', 'deposit_addr_usdc_bep20',
  ],
  BTC: ['deposit_addr_btc'],
  LTC: ['deposit_addr_ltc'],
}

async function main() {
  const tron = await generateTron()
  const evm = generateEvm()
  const btc = generateBtc()
  const ltc = generateLtc()
  const wallets = [tron, evm, btc, ltc]

  const secretPath = join(HERE, '.wallets.secret.json')
  writeFileSync(
    secretPath,
    JSON.stringify(
      { generatedAt: new Date().toISOString(), wallets },
      null,
      2,
    ),
    { mode: 0o600 },
  )

  console.log('\n✅ Wallets generated. Secrets written to:')
  console.log(`   ${secretPath}`)
  console.log('   (gitignored — BACK IT UP, keys are unrecoverable)\n')
  console.log('═══ PUBLIC ADDRESSES (safe to share) ═══\n')
  for (const w of wallets) {
    console.log(`── ${w.chain} ──`)
    console.log(`   ${w.address}`)
    console.log(`   → app_settings: ${KEY_MAP[w.chain].join(', ')}\n`)
  }
  console.log('Paste each address into Admin → Control → "Кошельки')
  console.log('пополнения" for the keys listed above (same EVM and')
  console.log('TRON address goes into several fields).\n')
}

main().catch((err) => {
  console.error('❌ Error:', err)
  process.exit(1)
})

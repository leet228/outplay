/**
 * generate-wallets.js — One-time script to generate 4 crypto wallets
 *
 * Usage:
 *   cd scripts
 *   npm install
 *   node generate-wallets.js
 *
 * Copy the output into your .env file (root of project).
 * ⚠️  BACK UP THE PRIVATE KEYS — they cannot be recovered!
 */

import { mnemonicNew, mnemonicToPrivateKey } from '@ton/crypto'
import { WalletContractV4 } from '@ton/ton'
import { TronWeb } from 'tronweb'
import * as bitcoin from 'bitcoinjs-lib'
import { ECPairFactory } from 'ecpair'
import * as ecc from 'tiny-secp256k1'
import { ethers } from 'ethers'

const ECPair = ECPairFactory(ecc)

// ── TON ──────────────────────────────────────────────
async function generateTon() {
  const mnemonic = await mnemonicNew(24)
  const keyPair = await mnemonicToPrivateKey(mnemonic)

  const wallet = WalletContractV4.create({
    workchain: 0,
    publicKey: keyPair.publicKey,
  })

  const address = wallet.address.toString({ bounceable: false })
  return {
    chain: 'TON',
    address,
    mnemonic: mnemonic.join(' '),
  }
}

// ── TRON (for USDT TRC-20) ───────────────────────────
async function generateTron() {
  const tw = new TronWeb({ fullHost: 'https://api.trongrid.io' })
  const account = await tw.createAccount()
  return {
    chain: 'TRON',
    address: account.address.base58,
    privateKey: account.privateKey,
  }
}

// ── Bitcoin ──────────────────────────────────────────
function generateBtc() {
  const keyPair = ECPair.makeRandom()
  const { address } = bitcoin.payments.p2wpkh({
    pubkey: Buffer.from(keyPair.publicKey),
  })
  const privateKeyWif = keyPair.toWIF()
  return {
    chain: 'BTC',
    address,
    privateKey: privateKeyWif,
  }
}

// ── Ethereum ─────────────────────────────────────────
function generateEth() {
  const wallet = ethers.Wallet.createRandom()
  return {
    chain: 'ETH',
    address: wallet.address,
    privateKey: wallet.privateKey,
  }
}

// ── Main ─────────────────────────────────────────────
async function main() {
  console.log('🔐 Generating 4 crypto wallets...\n')

  const [ton, tron, btc, eth] = await Promise.all([
    generateTon(),
    generateTron(),
    generateBtc(),
    generateEth(),
  ])

  console.log('═══════════════════════════════════════════')
  console.log('  ⚠️  SAVE THESE KEYS! THEY CANNOT BE')
  console.log('     RECOVERED IF LOST!')
  console.log('═══════════════════════════════════════════\n')

  // Pretty print
  for (const w of [ton, tron, btc, eth]) {
    console.log(`── ${w.chain} ──`)
    console.log(`  Address: ${w.address}`)
    if (w.mnemonic) console.log(`  Mnemonic: ${w.mnemonic}`)
    if (w.privateKey) console.log(`  Private Key: ${w.privateKey}`)
    console.log()
  }

  // .env format
  console.log('─── Copy below into .env ───────────────────\n')
  console.log(`# Crypto Wallets (generated ${new Date().toISOString()})`)
  console.log(`WALLET_TON_ADDRESS=${ton.address}`)
  console.log(`WALLET_TON_MNEMONIC=${ton.mnemonic}`)
  console.log(`WALLET_TRON_ADDRESS=${tron.address}`)
  console.log(`WALLET_TRON_PRIVATE_KEY=${tron.privateKey}`)
  console.log(`WALLET_BTC_ADDRESS=${btc.address}`)
  console.log(`WALLET_BTC_PRIVATE_KEY=${btc.privateKey}`)
  console.log(`WALLET_ETH_ADDRESS=${eth.address}`)
  console.log(`WALLET_ETH_PRIVATE_KEY=${eth.privateKey}`)
  console.log()
}

main().catch((err) => {
  console.error('❌ Error:', err)
  process.exit(1)
})

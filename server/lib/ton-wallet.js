/**
 * TON wallet — send TON from hot wallet using @ton/ton SDK
 * Uses seqno-based transfers (one at a time)
 */

import { TonClient, WalletContractV4, internal } from '@ton/ton'
import { mnemonicToPrivateKey } from '@ton/crypto'
import { Address, toNano } from '@ton/core'

const TONCENTER_ENDPOINT = 'https://toncenter.com/api/v2/jsonRPC'
const CONFIRMATION_TIMEOUT_MS = 60_000
const POLL_INTERVAL_MS = 2_000

let _client = null
function getClient() {
  if (!_client) {
    _client = new TonClient({
      endpoint: TONCENTER_ENDPOINT,
      apiKey: process.env.TONCENTER_API_KEY || undefined,
    })
  }
  return _client
}

/**
 * Send TON to an address from the hot wallet
 * @param {string} toAddress — destination TON address (UQ.../EQ.../0:hex)
 * @param {number} amountTon — amount in TON (e.g. 0.5)
 * @param {string} memo — optional comment
 * @returns {{ success: true, seqno: number }} on confirmation
 * @throws on failure or timeout
 */
export async function sendTon(toAddress, amountTon, memo = '') {
  const mnemonic = process.env.WALLET_TON_MNEMONIC
  if (!mnemonic) throw new Error('WALLET_TON_MNEMONIC not configured')

  const keyPair = await mnemonicToPrivateKey(mnemonic.split(' '))
  const wallet = WalletContractV4.create({
    workchain: 0,
    publicKey: keyPair.publicKey,
  })

  const client = getClient()
  const contract = client.open(wallet)

  // Get current seqno
  const seqno = await contract.getSeqno()

  // Build and send transfer
  await contract.sendTransfer({
    seqno,
    secretKey: keyPair.secretKey,
    messages: [
      internal({
        to: Address.parse(toAddress),
        value: toNano(amountTon.toFixed(9)),
        body: memo || undefined,
      }),
    ],
  })

  console.log(`[ton-wallet] Transfer sent: ${amountTon} TON → ${toAddress} (seqno ${seqno})`)

  // Wait for seqno increment (transaction confirmation)
  const deadline = Date.now() + CONFIRMATION_TIMEOUT_MS
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS))
    try {
      const newSeqno = await contract.getSeqno()
      if (newSeqno > seqno) {
        console.log(`[ton-wallet] Confirmed: seqno ${seqno} → ${newSeqno}`)
        return { success: true, seqno: newSeqno }
      }
    } catch (e) {
      // Transient RPC error — keep polling
      console.warn('[ton-wallet] Poll error:', e.message)
    }
  }

  throw new Error(`Transaction not confirmed after ${CONFIRMATION_TIMEOUT_MS / 1000}s (seqno ${seqno})`)
}

/**
 * Get hot wallet balance in TON
 */
export async function getWalletBalance() {
  const mnemonic = process.env.WALLET_TON_MNEMONIC
  if (!mnemonic) return 0

  const keyPair = await mnemonicToPrivateKey(mnemonic.split(' '))
  const wallet = WalletContractV4.create({
    workchain: 0,
    publicKey: keyPair.publicKey,
  })

  const client = getClient()
  const balance = await client.getBalance(wallet.address)
  return Number(balance) / 1e9
}

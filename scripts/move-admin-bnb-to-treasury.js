/**
 * One-off: move ALL BNB from the legacy admin EVM wallet
 * (generate-wallets.js, 0x8a22…) → the canonical treasury
 * (HD index 0). Sign offline, then broadcast the SAME signed
 * raw tx across several BSC RPCs with retries (idempotent — one
 * tx hash) so a flaky POST connection can't stop it.
 *
 *   cd scripts && node move-admin-bnb-to-treasury.js
 *
 * Key read from gitignored .wallets.secret.json, never printed.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { JsonRpcProvider, Wallet, HDNodeWallet, Transaction, formatEther } from 'ethers'

const HERE = dirname(fileURLToPath(import.meta.url))
const blob = JSON.parse(readFileSync(join(HERE, '.wallets.secret.json'), 'utf8'))
const src = (blob.wallets || []).find(w => w.chain === 'EVM')
if (!src?.privateKey || !blob.hdMnemonic) { console.error('missing keys'); process.exit(1) }

const RPCS = [
  'https://bsc-dataseed.bnbchain.org',
  'https://bsc-dataseed1.defibit.io',
  'https://bsc-dataseed1.ninicoin.io',
  'https://bsc.publicnode.com',
]
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function rpc(method, params) {
  for (let pass = 0; pass < 3; pass++) {
    for (const u of RPCS) {
      try {
        const res = await fetch(u, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        })
        const j = await res.json()
        if (j.error) throw new Error(j.error.message)
        return j.result
      } catch (e) {
        // try next endpoint / pass
        if (pass === 2 && u === RPCS[RPCS.length - 1]) throw e
      }
    }
    await sleep(800 * (pass + 1))
  }
}

const treasury = HDNodeWallet.fromPhrase(blob.hdMnemonic, undefined, "m/44'/60'/0'/0/0").address
const wallet = new Wallet(src.privateKey)

console.log(`Source  (legacy admin): ${src.address}`)
console.log(`Treasury (HD index 0):  ${treasury}`)

const balHex = await rpc('eth_getBalance', [src.address, 'latest'])
const bal = BigInt(balHex)
const gpHex = await rpc('eth_gasPrice', [])
const gasPrice = BigInt(gpHex)
const nonceHex = await rpc('eth_getTransactionCount', [src.address, 'pending'])
const nonce = parseInt(nonceHex, 16)
const cost = gasPrice * 21000n

console.log(`Balance: ${formatEther(bal)} BNB`)
if (bal <= cost) { console.log('Nothing to move (≤ gas fee).'); process.exit(0) }

const value = bal - cost
const tx = Transaction.from({
  to: treasury, value, nonce, gasLimit: 21000n, gasPrice,
  chainId: 56, type: 0,
})
tx.signature = wallet.signingKey.sign(tx.unsignedHash)
const raw = tx.serialized
const txHash = tx.hash

console.log(`Sending: ${formatEther(value)} BNB  (fee ≈ ${formatEther(cost)})`)
console.log(`Tx hash: ${txHash}`)

try {
  await rpc('eth_sendRawTransaction', [raw])
  console.log('Broadcast accepted.')
} catch (e) {
  // "already known"/"nonce too low" after a prior partial send = fine
  console.log('Broadcast note:', String(e.message || e))
}

console.log('Polling for receipt…')
for (let i = 0; i < 30; i++) {
  await sleep(3000)
  const r = await rpc('eth_getTransactionReceipt', [txHash]).catch(() => null)
  if (r) {
    console.log(BigInt(r.status) === 1n ? '✅ Confirmed.' : '⚠️ Reverted — check bscscan.')
    const t = await rpc('eth_getBalance', [treasury, 'latest'])
    console.log(`Treasury balance: ${formatEther(BigInt(t))} BNB`)
    process.exit(0)
  }
}
console.log(`Still pending — check https://bscscan.com/tx/${txHash}`)

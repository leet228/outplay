/**
 * tron-stake.js — one-time (operator-run): freeze TRX on the
 * treasury (HD index 0) for ENERGY, so sweeps can DELEGATE that
 * energy to user addresses and move USDT-TRC20 for ~0 TRX.
 *
 * Frozen TRX is COLLATERAL, not spent — you can unfreeze it later
 * (Stake 2.0: 14-day unbonding). Run with the amount of TRX to
 * freeze, e.g.:
 *
 *   cd scripts && node tron-stake.js 1000
 *
 * It prints how much Energy that yields at the current network
 * ratio so you can size it (a USDT-TRC20 transfer ≈ 65k energy;
 * to a fresh recipient ≈ 130k). Re-run to add more later.
 *
 * Key read from gitignored .wallets.secret.json, never printed.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { HDNodeWallet, SigningKey, keccak256, sha256, getBytes, encodeBase58 } from 'ethers'

const HERE = dirname(fileURLToPath(import.meta.url))
const blob = JSON.parse(readFileSync(join(HERE, '.wallets.secret.json'), 'utf8'))
if (!blob.hdMnemonic) { console.error('no hdMnemonic'); process.exit(1) }

const trxFloat = Number(process.argv[2] || '0')
if (!(trxFloat > 0)) {
  console.error('usage: node tron-stake.js <TRX amount to freeze>')
  process.exit(1)
}

const API = 'https://api.trongrid.io'
const priv = HDNodeWallet.fromPhrase(blob.hdMnemonic, undefined, "m/44'/195'/0'/0/0").privateKey

function addrFromPriv(p) {
  const pub = getBytes(SigningKey.computePublicKey(p, false)).slice(1)
  const h = getBytes(keccak256(pub))
  const a21 = new Uint8Array(21); a21[0] = 0x41; a21.set(h.slice(-20), 1)
  const chk = getBytes(sha256(sha256(a21))).slice(0, 4)
  const full = new Uint8Array(25); full.set(a21, 0); full.set(chk, 21)
  return encodeBase58(full)
}
const treasury = addrFromPriv(priv)

async function rpc(path, body) {
  const r = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!r.ok) throw new Error(`${path} HTTP ${r.status}`)
  return r.json()
}
function sign(tx) {
  const sk = new SigningKey(priv)
  const s = sk.sign('0x' + tx.txID)
  return { ...tx, signature: [s.r.slice(2) + s.s.slice(2) + (s.yParity ? '01' : '00')] }
}

console.log(`Treasury (HD-0 Tron): ${treasury}`)

const res = await rpc('/wallet/getaccountresource', { address: treasury, visible: true })
const totalE = Number(res?.TotalEnergyLimit || 0)
const totalW = Number(res?.TotalEnergyWeight || 0)
const ePerTrx = totalW > 0 ? totalE / totalW : 0
console.log(`Network: ~${ePerTrx.toFixed(1)} energy per 1 TRX staked`)
console.log(`Freezing ${trxFloat} TRX  →  ~${Math.floor(ePerTrx * trxFloat).toLocaleString()} energy`)

const built = await rpc('/wallet/freezebalancev2', {
  owner_address: treasury,
  frozen_balance: Math.round(trxFloat * 1e6),
  resource: 'ENERGY',
  visible: true,
})
if (!built?.txID) { console.error('freeze build failed:', JSON.stringify(built)); process.exit(1) }
const bc = await rpc('/wallet/broadcasttransaction', sign(built))
console.log(bc?.result === true || bc?.txid ? `✅ Staked. txid: ${built.txID}` : `⚠️ ${JSON.stringify(bc)}`)
console.log('Check energy in ~1 min: tron-stake will show it, or TronScan → treasury → Resources.')

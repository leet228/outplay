import 'dotenv/config'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { config } from 'dotenv'
import express from 'express'
import cors from 'cors'
import walletRoutes from './routes/wallets.js'
import withdrawalRoutes, { processOne as processWithdrawal } from './routes/withdrawals.js'

// Load .env from project root (one level up from server/)
const __dirname = dirname(fileURLToPath(import.meta.url))
config({ path: resolve(__dirname, '..', '.env') })

const app = express()
const PORT = process.env.SERVER_PORT || 3001

// CORS — allow frontend origins
app.use(cors({
  origin: [
    'http://localhost:5173',
    'http://localhost:5174',
    process.env.FRONTEND_URL,
  ].filter(Boolean),
}))

app.use(express.json())

// Admin auth — simple Bearer token
function adminAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '')
  if (!process.env.ADMIN_TOKEN) {
    return res.status(500).json({ error: 'ADMIN_TOKEN not configured' })
  }
  if (token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  next()
}

// Health check (no auth)
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() })
})

// Wallet routes (require admin auth)
app.use('/api/wallets', adminAuth, walletRoutes)

// Withdrawal routes (require admin auth)
app.use('/api/withdrawals', adminAuth, withdrawalRoutes)

app.listen(PORT, () => {
  console.log(`🚀 Outplay wallet server on http://localhost:${PORT}`)
  console.log(`   Health: http://localhost:${PORT}/api/health`)

  // Check wallet config
  const chains = ['TON', 'TRON', 'BTC', 'ETH']
  const configured = chains.filter(c =>
    process.env[`WALLET_${c}_ADDRESS`]
  )
  console.log(`   Wallets configured: ${configured.join(', ') || 'none'}`)

  // Auto-process withdrawal queue every 10s
  const WD_INTERVAL = 10_000
  setInterval(async () => {
    try {
      const result = await processWithdrawal()
      if (result.completed) {
        console.log(`[auto-wd] Processed withdrawal: ${result.ton_amount} TON`)
      } else if (result.failed) {
        console.warn(`[auto-wd] Withdrawal failed: ${result.reason}`)
      }
      // idle/skipped — do nothing
    } catch (err) {
      console.error('[auto-wd] Error:', err.message)
    }
  }, WD_INTERVAL)
  console.log(`   Withdrawal processor: every ${WD_INTERVAL / 1000}s`)
})

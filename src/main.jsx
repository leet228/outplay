import { createRoot } from 'react-dom/client'
import { TonConnectUIProvider } from '@tonconnect/ui-react'
import './index.css'
import App from './App.jsx'

if (import.meta.env.PROD) {
  const noop = () => {}
  console.log = noop
  console.debug = noop
  console.info = noop
  console.warn = noop
  console.error = noop
}

// TON Connect manifest — hosted at /tonconnect-manifest.json so
// wallets can read our app name + icon when prompting the user
// to confirm a connection. `twaReturnUrl` brings the user back
// to our Mini App after they approve in their wallet (Wallet
// in Telegram, Tonkeeper, etc.).
const TONCONNECT_MANIFEST_URL = `${window.location.origin}/tonconnect-manifest.json`
const TWA_RETURN_URL = 'https://t.me/outplaymoneybot'

createRoot(document.getElementById('root')).render(
  <TonConnectUIProvider
    manifestUrl={TONCONNECT_MANIFEST_URL}
    actionsConfiguration={{ twaReturnUrl: TWA_RETURN_URL }}
  >
    <App />
  </TonConnectUIProvider>
)

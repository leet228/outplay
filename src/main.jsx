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

// TON Connect manifest — hosted at outplay-mini-app.com so the
// wallet's confirm dialog reads "Connect outplay-mini-app.com"
// (the branded URL we own) instead of the bare Vercel preview
// host the Mini App is actually served from. Hardcoded — the
// Mini App can run on any host (preview deploys, the legacy
// outplay-nu.vercel.app, etc.) but the manifest source of
// truth never moves.
const TONCONNECT_MANIFEST_URL = 'https://outplay-mini-app.com/tonconnect-manifest.json'
const TWA_RETURN_URL = 'https://t.me/outplaymoneybot'

createRoot(document.getElementById('root')).render(
  <TonConnectUIProvider
    manifestUrl={TONCONNECT_MANIFEST_URL}
    actionsConfiguration={{ twaReturnUrl: TWA_RETURN_URL }}
  >
    <App />
  </TonConnectUIProvider>
)

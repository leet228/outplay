import { createRoot } from 'react-dom/client'
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

createRoot(document.getElementById('root')).render(<App />)

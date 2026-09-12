import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register(new URL('./sw.js', document.baseURI), { scope: './', updateViaCache: 'none' }).catch((error: unknown) => {
      // Offline-cache setup is optional; a failed update must not disable local
      // CSV parsing or hide the user's library behind the global error screen.
      console.warn('FlightTrace offline cache could not be updated.', error)
    })
  })
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)

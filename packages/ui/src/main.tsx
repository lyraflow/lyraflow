import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.js'
import { SharedApp } from './app/SharedApp.js'
import { sharedTokenOf } from './app/entry.js'
import './styles/theme.css'

const root = document.getElementById('root')
if (!root) throw new Error('missing #root')

// Which of the two apps this page is, decided from the pathname BEFORE
// anything mounts. `App` calls `GET /v1/auth/session` in its first effect
// and shows the login form on the 401 a viewer will always get, so the
// choice cannot be made inside it: by then the request has gone out and the
// wrong screen is already what happens next. See `app/entry.ts`.
//
// Read once, not watched: neither entry point routes, so the pathname
// cannot change under this without a full page load.
const token = sharedTokenOf(window.location.pathname)

createRoot(root).render(
  <StrictMode>{token === null ? <App /> : <SharedApp token={token} />}</StrictMode>,
)

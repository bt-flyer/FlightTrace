import { useEffect, useState } from 'react'
import { AppErrorBoundary } from './components/AppErrorBoundary'
import { LibraryPage } from './pages/LibraryPage'
import { LogPage } from './pages/LogPage'
import { ModelPage } from './pages/ModelPage'
import { SetupPage } from './pages/SetupPage'
import { StoragePage } from './pages/StoragePage'
import { UnitSettingsPage } from './pages/UnitSettingsPage'
import { db } from './db'
import { DEFAULT_UNIT_PREFERENCES, normalizeUnitPreferences, UNIT_PREFERENCES_KEY, type UnitPreferences } from './lib/units'
import { Link } from './router'

function currentPath() {
  return window.location.hash.replace(/^#/, '') || '/'
}

function AppShell() {
  const [revision, setRevision] = useState(0)
  const [path, setPath] = useState(currentPath)
  const [unitPreferences, setUnitPreferences] = useState<UnitPreferences>(DEFAULT_UNIT_PREFERENCES)
  const refresh = () => setRevision((value) => value + 1)
  useEffect(() => {
    const update = () => setPath(currentPath())
    window.addEventListener('hashchange', update)
    return () => window.removeEventListener('hashchange', update)
  }, [])
  useEffect(() => { void db.settings.get(UNIT_PREFERENCES_KEY).then((setting) => setUnitPreferences(normalizeUnitPreferences(setting?.value))).catch(() => setUnitPreferences(DEFAULT_UNIT_PREFERENCES)) }, [revision])
  async function saveUnitPreferences(next: UnitPreferences) {
    setUnitPreferences(next)
    await db.settings.put({ key: UNIT_PREFERENCES_KEY, value: next })
  }
  const modelMatch = path.match(/^\/model\/([^/]+)$/)
  const logMatch = path.match(/^\/log\/([^/]+)$/)
  const setupMatch = path.match(/^\/setup\/([^/]+)$/)
  let page = <LibraryPage revision={revision} refresh={refresh} />
  if (path === '/storage') page = <StoragePage refresh={refresh} />
  else if (path === '/units') page = <UnitSettingsPage preferences={unitPreferences} onChange={saveUnitPreferences} />
  else if (modelMatch) page = <ModelPage modelId={decodeURIComponent(modelMatch[1])} revision={revision} refresh={refresh} />
  else if (logMatch) page = <LogPage logId={decodeURIComponent(logMatch[1])} revision={revision} refresh={refresh} unitPreferences={unitPreferences} />
  else if (setupMatch) page = <SetupPage modelId={decodeURIComponent(setupMatch[1])} refresh={refresh} />
  return <div className="app"><header className="site-header"><Link className="brand" to="/"><span className="brand-mark">✦</span><span>FLIGHT<em>TRACE</em></span></Link><nav><Link to="/">Library</Link><Link to="/units">Units</Link><Link to="/storage">Storage</Link></nav></header>{page}<footer><span>FlightTrace public beta · © 2026 FlightTrace contributors · <a href="https://github.com/bt-flyer/FlightTrace/blob/main/LICENSE" target="_blank" rel="noreferrer">GNU GPLv3</a></span><span>Telemetry analysis is advisory. Always follow equipment guidance. Provided “as is,” without warranties.</span></footer></div>
}

export default function App() { return <AppErrorBoundary><AppShell /></AppErrorBoundary> }

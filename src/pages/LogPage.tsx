import { useEffect, useMemo, useRef, useState } from 'react'
import { FlightInsights, type InsightsReport, type TraceFocus } from '../components/FlightInsights'
import { FlightPathMap } from '../components/FlightPathMap'
import { MAX_GRAPH_CHANNELS, TelemetryChart } from '../components/TelemetryChart'
import { TelemetryQuery } from '../components/TelemetryQuery'
import { db } from '../db'
import { displayChannelName } from '../lib/channels'
import { parseTelemetryFile } from '../lib/workerClient'
import { rawLogBlob } from '../lib/rawLog'
import { detectFlights, evaluateRules, FLIGHT_DETECTION_VERSION } from '../lib/analysis'
import { graphSelectionForModel, pinnedGraphChannels } from '../lib/graphSelection'
import { convertParsedForDisplay, type UnitPreferences } from '../lib/units'
import { Link } from '../router'
import type { DiagnosticEvent, FlightSegment, LogRecord, ModelProfile, ParsedLog } from '../types'

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url; anchor.download = name; anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function floatingTime(ms: number) {
  return new Date(ms).toISOString().slice(11, 19)
}

export function LogPage({ logId, revision, refresh, unitPreferences }: { logId: string; revision: number; refresh: () => void; unitPreferences: UnitPreferences }) {
  const [log, setLog] = useState<LogRecord>()
  const [model, setModel] = useState<ModelProfile>()
  const [parsed, setParsed] = useState<ParsedLog>()
  const [flights, setFlights] = useState<FlightSegment[]>([])
  const [events, setEvents] = useState<DiagnosticEvent[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [progress, setProgress] = useState('Loading log…')
  const [splitCursorMs, setSplitCursorMs] = useState<number>()
  const [graphFullscreen, setGraphFullscreen] = useState(false)
  const [graphSelectionStatus, setGraphSelectionStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [focusRange, setFocusRange] = useState<{ startMs: number; endMs: number }>()
  const [insights, setInsights] = useState<InsightsReport>()
  const [loadError, setLoadError] = useState('')
  const chartPanel = useRef<HTMLElement>(null)

  useEffect(() => {
    if (!graphFullscreen) return
    const previousOverflow = document.body.style.overflow
    const exitOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setGraphFullscreen(false) }
    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', exitOnEscape)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', exitOnEscape)
    }
  }, [graphFullscreen])

  useEffect(() => {
    let cancelled = false
    let cancelParse: (() => void) | undefined
    void (async () => {
      try {
        const loadedLog = await db.logs.get(logId)
        if (cancelled) return
        setLoadError('')
        if (!loadedLog) throw new Error('This log is no longer available.')
        const [loadedModel, loadedFlights] = await Promise.all([db.models.get(loadedLog.modelId), db.flights.where('logId').equals(logId).sortBy('startMs')])
        if (cancelled) return
        if (!loadedModel) throw new Error('The model for this log is no longer available.')
        const request = parseTelemetryFile(rawLogBlob(loadedLog.rawBlob), loadedLog.fileName, ({ progress: value, stage }) => { if (!cancelled) setProgress(`${stage} ${Math.round(value * 100)}%`) })
        cancelParse = request.cancel
        const result = await request.promise
        if (cancelled) return
        loadedLog.channels = result.channels
        loadedLog.summaries = result.summaries
        loadedLog.warnings = result.warnings
        loadedLog.schemaFingerprint = result.schemaFingerprint
        await db.logs.update(logId, { channels: result.channels, summaries: result.summaries, warnings: result.warnings, schemaFingerprint: result.schemaFingerprint })
        let currentFlights = loadedFlights
        if (loadedLog.flightDetectionVersion !== FLIGHT_DETECTION_VERSION && !loadedFlights.some((flight) => flight.manual || flight.excluded)) {
          currentFlights = detectFlights(result, loadedModel.id, loadedLog.id, loadedModel.flightRule)
          await db.transaction('rw', db.logs, db.flights, async () => {
            await db.flights.where('logId').equals(logId).delete()
            if (currentFlights.length) await db.flights.bulkAdd(currentFlights)
            await db.logs.update(logId, { flightDetectionVersion: FLIGHT_DETECTION_VERSION })
          })
          loadedLog.flightDetectionVersion = FLIGHT_DETECTION_VERSION
        }
        if (cancelled) return
        const currentEvents = evaluateRules(result, logId, loadedModel.rules)
        await db.transaction('rw', db.events, async () => {
          await db.events.where('logId').equals(logId).delete()
          if (currentEvents.length) await db.events.bulkAdd(currentEvents)
        })
        if (cancelled) return
        setModel(loadedModel); setEvents(currentEvents)
        setLog(loadedLog); setFlights(currentFlights)
        setParsed(result); setProgress('')
        setFocusRange(undefined)
        setInsights(undefined)
        setSelected(graphSelectionForModel(loadedModel, result.channels, MAX_GRAPH_CHANNELS))
        setGraphSelectionStatus(loadedModel.graphChannelKeys === undefined ? 'idle' : 'saved')
      } catch (error) {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : 'This log could not be loaded.')
      }
    })()
    return () => { cancelled = true; cancelParse?.() }
  }, [logId, revision])

  const displayParsed = useMemo(() => parsed ? convertParsedForDisplay(parsed, unitPreferences) : undefined, [parsed, unitPreferences])
  const selectedSummaries = useMemo(() => displayParsed?.summaries.filter((summary) => selected.includes(summary.channelKey)) ?? [], [displayParsed, selected])
  const cellDeviationSummaries = useMemo(() => displayParsed?.summaries.filter((summary) => displayParsed.channels.find((channel) => channel.key === summary.channelKey)?.derivedKind === 'lipo-cell-deviation') ?? [], [displayParsed])
  if (loadError) return <main className="page-shell"><p role="alert">{loadError}</p><button className="button primary" onClick={refresh}>Retry loading log</button></main>
  if (!log || log.id !== logId || !model || !parsed || !displayParsed) return <main className="page-shell"><div className="loading-panel"><span className="spinner"></span><p>{progress}</p></div></main>
  const currentLog = log
  const currentModel = model
  const currentParsed = parsed
  const currentDisplayParsed = displayParsed
  const pinnedSelection = pinnedGraphChannels(currentModel, currentParsed.channels, MAX_GRAPH_CHANNELS)

  function reviewTrace(focus: TraceFocus) {
    const keys = focus.channelKeys.filter((key) => currentParsed.channels.some((channel) => channel.key === key && channel.kind === 'numeric')).slice(0, MAX_GRAPH_CHANNELS)
    if (keys.length) setSelected(keys)
    setFocusRange({ startMs: Math.max(currentParsed.startMs, focus.startMs - 10_000), endMs: Math.min(currentParsed.endMs, focus.endMs + 10_000) })
    chartPanel.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  async function updateFlight(flight: FlightSegment, patch: Partial<FlightSegment>) {
    await db.flights.update(flight.id, { ...patch, manual: true })
    refresh()
  }

  async function splitFlight(flight: FlightSegment, splitMs: number) {
    if (splitMs <= flight.startMs || splitMs >= flight.endMs) return
    await db.transaction('rw', db.flights, async () => {
      await db.flights.update(flight.id, { endMs: splitMs, manual: true })
      await db.flights.add({ ...flight, id: crypto.randomUUID(), ordinal: flight.ordinal + 1, startMs: splitMs, manual: true })
      const ordered = await db.flights.where('logId').equals(flight.logId).sortBy('startMs')
      for (let index = 0; index < ordered.length; index += 1) await db.flights.update(ordered[index].id, { ordinal: index + 1 })
    }); refresh()
  }

  async function saveGraphSelection(next: string[]) {
    const updatedAt = new Date().toISOString()
    setSelected(next)
    setModel((current) => current ? { ...current, graphChannelKeys: next, updatedAt } : current)
    setGraphSelectionStatus('saving')
    try {
      await db.models.update(currentModel.id, { graphChannelKeys: next, updatedAt })
      setGraphSelectionStatus('saved')
    } catch {
      setGraphSelectionStatus('error')
    }
  }

  function exportDataCsv() {
    const keys = selected
    const rows = [['Timestamp', ...keys.map((key) => {
      const channel = currentDisplayParsed.channels.find((candidate) => candidate.key === key)
      const label = currentModel.channelSettings[key]?.label ?? channel?.label ?? key
      return `${label}${channel?.unit ? ` (${channel.unit})` : ''}`
    })]]
    for (let index = 0; index < currentDisplayParsed.timestamps.length; index += 1) rows.push([new Date(currentDisplayParsed.timestamps[index]).toISOString().replace('Z', ''), ...keys.map((key) => currentDisplayParsed.series[key][index]?.toString() ?? '')])
    const csv = rows.map((row) => row.map((value) => /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value).join(',')).join('\n')
    download(new Blob([csv], { type: 'text/csv' }), `${currentLog.fileName.replace(/\.csv$/i, '')}-normalized.csv`)
  }

  function exportReportJson() {
    download(new Blob([JSON.stringify({ model: { id: currentModel.id, name: currentModel.name }, log: { ...currentLog, rawBlob: undefined }, flights, events, insights: insights?.logId === currentLog.id ? insights : undefined }, null, 2)], { type: 'application/json' }), `${currentLog.fileName.replace(/\.csv$/i, '')}-report.json`)
  }

  return <main className="page-shell report-page">
    <Link className="back-link no-print" to={`/model/${model.id}`}>← {model.name}</Link>
    <section className="analysis-header"><div><span className="eyebrow">Flight analysis</span><h1>{log.startLocal.slice(0, 10)} <em>{log.startLocal.slice(11, 19)}</em></h1><p>{log.fileName}</p></div><div className="button-row no-print"><button className="button ghost" onClick={exportDataCsv}>Export data</button><button className="button ghost" onClick={exportReportJson}>Export JSON</button><button className="button primary" onClick={() => window.print()}>Print / PDF</button></div></section>
    <section className="metric-strip"><div><span>Duration</span><strong>{((log.endMs - log.startMs) / 60000).toFixed(1)} min</strong></div><div><span>Samples</span><strong>{log.rowCount.toLocaleString()}</strong></div><div><span>Flights</span><strong>{flights.filter((flight) => !flight.excluded).length}</strong></div><div><span>Events</span><strong>{events.length}</strong></div></section>

    <section ref={chartPanel} className={`analysis-panel chart-panel${graphFullscreen ? ' fullscreen' : ''}`}><div className="panel-heading"><div><span className="eyebrow">Interactive trace</span><h2>Telemetry channels</h2></div><div className="chart-selection-actions no-print"><span>{selected.length} / {MAX_GRAPH_CHANNELS} selected</span><span className={`graph-selection-status ${graphSelectionStatus}`} aria-live="polite">{focusRange ? 'Reviewing episode' : graphSelectionStatus === 'saving' ? 'Saving…' : graphSelectionStatus === 'saved' ? 'Saved for this plane' : graphSelectionStatus === 'error' ? 'Could not save selection' : 'Selection is per plane'}</span><button className="button ghost small" disabled={!pinnedSelection.length} title={pinnedSelection.length ? 'Restore this plane’s pinned channels' : 'No channels are pinned for this plane'} onClick={() => void saveGraphSelection(pinnedSelection)}>Pinned ({pinnedSelection.length})</button><button className="button ghost small" onClick={() => void saveGraphSelection([])}>Clear</button><button className="button primary small" aria-pressed={graphFullscreen} onClick={() => setGraphFullscreen((current) => !current)}>{graphFullscreen ? 'Exit full screen' : 'Full screen'}</button></div></div><div className="channel-pills no-print">{displayParsed.channels.filter((channel) => channel.kind !== 'empty').map((channel) => <label className={selected.includes(channel.key) ? 'channel-pill selected' : 'channel-pill'} key={channel.key}><input type="checkbox" checked={selected.includes(channel.key)} disabled={!selected.includes(channel.key) && selected.length >= MAX_GRAPH_CHANNELS} onChange={(event) => { const next = event.target.checked ? selected.length < MAX_GRAPH_CHANNELS ? [...selected, channel.key] : selected : selected.filter((key) => key !== channel.key); void saveGraphSelection(next) }} />{model.channelSettings[channel.key]?.label ?? displayChannelName(channel)}</label>)}</div><TelemetryChart parsed={displayParsed} channelKeys={selected} onCursorTimeChange={setSplitCursorMs} expanded={graphFullscreen} focusRange={focusRange} />{focusRange && <div className="trace-focus-note"><span>Review window +{((focusRange.startMs - parsed.startMs) / 1000).toFixed(1)}–{((focusRange.endMs - parsed.startMs) / 1000).toFixed(1)} s</span><button className="button ghost small no-print" onClick={() => { setFocusRange(undefined); setSelected(graphSelectionForModel(currentModel, currentParsed.channels, MAX_GRAPH_CHANNELS)) }}>Show full recording</button></div>}</section>

    <div className="analysis-grid"><section className="analysis-panel"><div className="panel-heading"><div><span className="eyebrow">Editable</span><h2>Flight segments</h2></div><span className="split-cursor-status">{splitCursorMs === undefined ? 'Move the chart cursor to choose a split point' : `Split cursor +${((splitCursorMs - log.startMs) / 1000).toFixed(1)}s`}</span></div><div className="segment-list">{flights.map((flight) => { const canSplit = splitCursorMs !== undefined && splitCursorMs > flight.startMs && splitCursorMs < flight.endMs; return <div className={flight.excluded ? 'segment-row excluded' : 'segment-row'} key={flight.id}><strong>Flight {flight.ordinal}</strong><label>Start +<input type="number" step="0.1" value={((flight.startMs - log.startMs) / 1000).toFixed(1)} onChange={(event) => void updateFlight(flight, { startMs: log.startMs + Number(event.target.value) * 1000 })} />s</label><label>End +<input type="number" step="0.1" value={((flight.endMs - log.startMs) / 1000).toFixed(1)} onChange={(event) => void updateFlight(flight, { endMs: log.startMs + Number(event.target.value) * 1000 })} />s</label><button className="button ghost small" disabled={!canSplit} onClick={() => { if (canSplit) void splitFlight(flight, splitCursorMs) }}>Split at cursor</button><button className="button ghost small" onClick={() => void updateFlight(flight, { excluded: !flight.excluded })}>{flight.excluded ? 'Include' : 'Exclude'}</button></div> })}{!flights.length && <p className="muted">No flights matched this model’s current detection criteria. Adjust them in Model setup or treat the recording as unclassified.</p>}</div></section>
      <section className="analysis-panel"><div className="panel-heading"><div><span className="eyebrow">Diagnostics</span><h2>Event timeline</h2></div></div><div className="event-list">{events.map((event) => <div className="event-row" key={event.id}><span className={`severity ${event.severity}`}></span><time>{floatingTime(event.startMs)}</time><div><strong>{event.ruleName}</strong><small>{event.message}</small></div></div>)}{!events.length && <p className="muted">No configured diagnostic events were detected.</p>}</div></section></div>

    <FlightInsights parsed={parsed} model={model} flights={flights} events={events} unitPreferences={unitPreferences} onFocus={reviewTrace} onReport={setInsights} />

    {cellDeviationSummaries.length > 0 && <section className="analysis-panel"><div className="panel-heading"><div><span className="eyebrow">Battery health</span><h2>LiPo cell balance</h2></div></div><div className="table-wrap"><table><thead><tr><th>Cell bank</th><th>Maximum deviation</th><th>P95 deviation</th><th>Median deviation</th><th>Coverage</th></tr></thead><tbody>{cellDeviationSummaries.map((summary) => { const channel = parsed.channels.find((item) => item.key === summary.channelKey); return <tr key={summary.channelKey}><td>{channel?.label ?? summary.channelKey}</td><td>{summary.max?.toFixed(3) ?? '—'} V</td><td>{summary.p95?.toFixed(3) ?? '—'} V</td><td>{summary.median?.toFixed(3) ?? '—'} V</td><td>{(summary.coverage * 100).toFixed(1)}%</td></tr> })}</tbody></table></div></section>}

    <section className="analysis-panel"><div className="panel-heading"><div><span className="eyebrow">Selected signals</span><h2>Statistics</h2></div></div><div className="table-wrap"><table><thead><tr><th>Channel</th><th>Coverage</th><th>Minimum</th><th>Average</th><th>Median</th><th>P95</th><th>Maximum</th><th>Gaps</th></tr></thead><tbody>{selectedSummaries.map((summary) => { const channel = displayParsed.channels.find((item) => item.key === summary.channelKey); const unit = channel?.unit ? ` ${channel.unit}` : ''; return <tr key={summary.channelKey}><td>{model.channelSettings[summary.channelKey]?.label ?? channel?.label}</td><td>{(summary.coverage * 100).toFixed(1)}%</td><td>{summary.min?.toFixed(2) ?? '—'}{unit}</td><td>{summary.timeWeightedMean?.toFixed(2) ?? '—'}{unit}</td><td>{summary.median?.toFixed(2) ?? '—'}{unit}</td><td>{summary.p95?.toFixed(2) ?? '—'}{unit}</td><td>{summary.max?.toFixed(2) ?? '—'}{unit}</td><td>{summary.gaps}</td></tr> })}</tbody></table></div></section>
    {log.warnings.length > 0 && <details className="warnings"><summary>Import notes ({log.warnings.length})</summary><ul>{log.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></details>}
    <FlightPathMap parsed={displayParsed} unitPreferences={unitPreferences} />
    <TelemetryQuery parsed={displayParsed} channelSettings={model.channelSettings} selectedChannelKeys={selected} />
  </main>
}

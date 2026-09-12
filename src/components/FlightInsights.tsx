import { useEffect, useMemo } from 'react'
import type { DiagnosticEvent, FlightSegment, ModelProfile, ParsedLog } from '../types'
import { reconstructIncidents, type Incident } from '../lib/incidents'
import { analyzeRf, type RfAnalysis } from '../lib/rfAnalysis'
import { useFlightHistory } from '../lib/useFlightHistory'
import { HISTORY_LIMIT, MIN_HISTORY_LOGS, type HistoricalComparison, type OperatingBand } from '../lib/historyAnalysis'
import { channelQuantity, convertQuantityValue, type UnitPreferences } from '../lib/units'
import { displayChannelName } from '../lib/channels'

export interface TraceFocus { startMs: number; endMs: number; channelKeys: string[] }
export interface InsightsReport {
  version: 1
  logId: string
  incidents: Incident[]
  rf: RfAnalysis
  history: { status: string; band?: OperatingBand; comparisons: HistoricalComparison[]; scanned: number; skipped: number }
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`
const percent = (part: number, total: number) => total > 0 ? `${(part / total * 100).toFixed(1)}%` : '—'

export function FlightInsights({ parsed, model, flights, events, unitPreferences, onFocus, onReport }: {
  parsed: ParsedLog
  model: ModelProfile
  flights: FlightSegment[]
  events: DiagnosticEvent[]
  unitPreferences: UnitPreferences
  onFocus: (focus: TraceFocus) => void
  onReport: (report: InsightsReport) => void
}) {
  const incidents = useMemo(() => reconstructIncidents(parsed, events, flights), [parsed, events, flights])
  const rf = useMemo(() => analyzeRf(parsed, model, flights), [parsed, model, flights])
  const history = useFlightHistory(parsed, flights, model.id, model.flightRule)
  const { band, comparisons, scanned, skipped, status } = history
  const historyStatus = !band || !history.current?.metrics.length ? 'insufficient-data' : status
  const report = useMemo<InsightsReport>(() => ({ version: 1, logId: parsed.hash, incidents, rf, history: { status: historyStatus, band, comparisons, scanned, skipped } }), [parsed.hash, incidents, rf, historyStatus, band, comparisons, scanned, skipped])
  useEffect(() => { onReport(report) }, [report, onReport])

  const elapsed = (timestamp: number) => `+${seconds(timestamp - parsed.startMs)}`
  const name = (key: string) => {
    const channel = parsed.channels.find((item) => item.key === key)
    return model.channelSettings[key]?.label || (channel ? displayChannelName(channel) : key)
  }
  const valueLabel = (key: string, value: number) => {
    const channel = parsed.channels.find((item) => item.key === key)
    if (!channel) return value.toFixed(2)
    const quantity = channelQuantity(channel)
    const target = quantity ? unitPreferences[quantity] : 'source'
    const unit = target === 'source' ? channel.unit : target
    const converted = quantity ? convertQuantityValue(value, quantity, channel.unit, target) : value
    return `${converted.toFixed(2)}${unit ? ` ${unit}` : ''}`
  }
  const unusual = comparisons.filter((comparison) => comparison.unusual)

  return <div className="flight-insights">
    <section className="analysis-panel" aria-labelledby="incidents-heading">
      <div className="panel-heading"><div><span className="eyebrow">Connected observations</span><h2 id="incidents-heading">Incident review</h2></div><span className="insight-count">{incidents.length} episode{incidents.length === 1 ? '' : 's'}</span></div>
      <p className="muted insight-note">Nearby alerts are grouped by their recorded timing. Their order does not establish a cause, and a logging gap alone does not prove loss of control. Excluded segments are omitted.</p>
      {!incidents.length && <p className="muted">No configured alerts to reconstruct in the included recording.</p>}
      <div className="incident-list">{incidents.map((incident, index) => <article className="incident-card" key={incident.id}>
        <div className="incident-heading"><div><span className={`severity ${incident.severity}`}></span><strong>Episode {index + 1}</strong><span className="muted">{elapsed(incident.startMs)}–{elapsed(incident.endMs)} · {incident.flightOrdinal ? `Flight ${incident.flightOrdinal}` : 'Outside flight segments'}</span></div><button className="button ghost small no-print" onClick={() => onFocus(incident)}>Review episode {index + 1}</button></div>
        <p>{incident.observation}</p>
        <details><summary>{incident.events.length} recorded alert{incident.events.length === 1 ? '' : 's'} · {incident.severity}</summary><ol className="incident-observations">{incident.events.map((event) => <li key={event.id}><time>{elapsed(event.startMs)}</time><span>{event.ruleName} <small>· {seconds(event.endMs - event.startMs)}</small></span></li>)}</ol></details>
      </article>)}</div>
    </section>

    <section className="analysis-panel" aria-labelledby="history-heading">
      <div className="panel-heading"><div><span className="eyebrow">This aircraft over time</span><h2 id="history-heading">Compared with previous flights</h2></div>{comparisons.length > 0 && <span className="insight-count">{unusual.length} unusual reading{unusual.length === 1 ? '' : 's'}</span>}</div>
      {!band || !history.current?.metrics.length ? <p className="muted">Not enough comparable telemetry in included flight segments. Comparison needs throttle or RPM and at least 10 seconds of another measured signal in a shared operating range.</p> : <>
        <p className="insight-note">Matching <strong>{name(band.channelKey)} {band.lower.toFixed(1)}–{band.upper.toFixed(1)} {band.unit}</strong> (upper bound excluded), using only included segments.</p>
        <p className="muted insight-note">Time-weighted medians are compared with up to {HISTORY_LIMIT} earlier logs for this aircraft. Each signal needs {MIN_HISTORY_LOGS} earlier logs, 10 seconds of observations per log, and 80% coverage in this range. Flight phase, weather, battery identity, and setup changes are not matched.</p>
        {status === 'loading' && <p className="muted" role="status">Comparing earlier logs… {scanned} / {history.total}</p>}
        {status === 'error' && <p role="alert">Previous logs could not be read. Reopen this log to retry.</p>}
        {skipped > 0 && <p className="muted">{skipped} earlier log{skipped === 1 ? '' : 's'} could not be parsed and were skipped.</p>}
        {status === 'ready' && !comparisons.length && <p className="muted">Insufficient matching history after checking {scanned} earlier log{scanned === 1 ? '' : 's'}. Import more flights with the same channel names, units, and operating range.</p>}
        {comparisons.length > 0 && <>
          <p>{unusual.length ? `${unusual.length} signal${unusual.length === 1 ? ' differs' : 's differ'} from the previous pattern. Review the traces and any setup changes.` : 'No unusual readings in the signals with enough matching history.'}</p>
          {unusual.map((comparison) => <div className="history-finding" key={comparison.channelKey}><strong>{name(comparison.channelKey)}</strong><span>{valueLabel(comparison.channelKey, comparison.current)} now · {valueLabel(comparison.channelKey, comparison.baseline)} historical median</span><span className="insight-count">{comparison.current > comparison.baseline ? 'Higher' : 'Lower'} than usual</span></div>)}
          <details className="history-details"><summary>Comparison evidence ({comparisons.length} signals)</summary><div className="table-wrap"><table><thead><tr><th>Signal</th><th>This log</th><th>Historical median</th><th>Comparison range</th><th>Earlier logs</th></tr></thead><tbody>{comparisons.map((comparison) => <tr key={comparison.channelKey}><td>{name(comparison.channelKey)}</td><td>{valueLabel(comparison.channelKey, comparison.current)}</td><td>{valueLabel(comparison.channelKey, comparison.baseline)}</td><td>{valueLabel(comparison.channelKey, comparison.lower)}–{valueLabel(comparison.channelKey, comparison.upper)}</td><td>{comparison.historicalLogs}</td></tr>)}</tbody></table></div><p className="muted insight-note">The comparison range uses three robust standard deviations around the historical median, with a minimum change allowance for each signal. It is a screening range, not an equipment limit or a prediction interval.</p></details>
        </>}
      </>}
    </section>

    <section className="analysis-panel" aria-labelledby="rf-heading">
      <div className="panel-heading"><div><span className="eyebrow">Receiver and band observations</span><h2 id="rf-heading">RF redundancy</h2></div></div>
      <p className="muted insight-note">Durations use observed intervals in included flight segments. Missing samples and long gaps are omitted. Recorded values may be stale if the logger does not provide freshness flags.</p>
      {!rf.channels.length ? <p className="muted">No numeric RSSI or VFR channels were found.</p> : <>
        <div className="table-wrap"><table><thead><tr><th>Channel</th><th>Link identity</th><th>Below threshold</th><th>Time low</th><th>Longest low</th><th>Coverage</th></tr></thead><tbody>{rf.channels.map((channel) => <tr key={channel.channelKey}><td>{name(channel.channelKey)}</td><td>{channel.identity ?? 'Unidentified / ambiguous'}</td><td>{channel.threshold === undefined ? 'Not configured' : valueLabel(channel.channelKey, channel.threshold)}</td><td>{channel.threshold === undefined || !channel.observedMs ? '—' : seconds(channel.lowMs)}</td><td>{channel.threshold === undefined || !channel.observedMs ? '—' : seconds(channel.longestLowMs)}</td><td>{percent(channel.observedMs, rf.flightMs)}</td></tr>)}</tbody></table></div>
        <p className="muted insight-note">Thresholds use the highest enabled low-value rule for each channel, or 50% for VFR without a rule. RSSI needs a configured rule. Values exactly at the threshold are not counted as low.</p>
        {!rf.pairs.length && <p className="muted">No independent links could be paired. In Model setup, give channel display names explicit identities such as “RX1 VFR” and “RX2 VFR”, or “VFR 2.4G” and “VFR 900M”, only when they represent separately recorded links. Duplicate names and source-switching aggregate channels cannot establish redundancy.</p>}
        <div className="rf-pairs">{rf.pairs.map((pair) => <article className="incident-card" key={`${pair.firstKey}:${pair.secondKey}`}>
          <h3>{name(pair.firstKey)} / {name(pair.secondKey)}</h3>
          {!pair.observedMs ? <p className="muted">No simultaneous observations in included flight segments.</p> : <>
            <dl className="rf-metrics"><div><dt>Both low</dt><dd>{seconds(pair.bothLowMs)} <small>({percent(pair.bothLowMs, pair.observedMs)})</small></dd></div><div><dt>Longest simultaneous low</dt><dd>{seconds(pair.longestBothLowMs)}</dd></div><div><dt>Joint coverage</dt><dd>{percent(pair.observedMs, rf.flightMs)}</dd></div></dl>
            <p className="muted insight-note">{name(pair.firstKey)} alone was low for {seconds(pair.firstOnlyLowMs)}; {name(pair.secondKey)} alone was low for {seconds(pair.secondOnlyLowMs)}. The other measured channel stayed at or above its threshold during those intervals. This does not confirm receiver switching or control delivery.</p>
            {pair.episodes.length > 0 && <details><summary>Simultaneous low episodes ({pair.episodes.length})</summary><ul className="rf-episodes">{pair.episodes.map((episode) => <li key={episode.startMs}><span>{elapsed(episode.startMs)} · {seconds(episode.endMs - episode.startMs)}</span><button className="button ghost small no-print" onClick={() => onFocus({ ...episode, channelKeys: [pair.firstKey, pair.secondKey] })}>Review RF episode</button></li>)}</ul></details>}
          </>}
        </article>)}</div>
      </>}
    </section>
  </div>
}

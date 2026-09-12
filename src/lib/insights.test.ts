import { describe, expect, it } from 'vitest'
import type { DiagnosticEvent, DiagnosticRule, FlightSegment, ModelProfile, ParsedLog } from '../types'
import { flightIntervals } from './insightSamples'
import { reconstructIncidents } from './incidents'
import { analyzeRf } from './rfAnalysis'
import { buildFlightProfile, chooseOperatingBand, compareFlightHistory } from './historyAnalysis'
import { evaluateRules } from './analysis'

function log(series: ParsedLog['series'], options: Partial<ParsedLog> = {}): ParsedLog {
  const length = Object.values(series)[0].length
  return {
    hash: 'current', fileName: 'test.csv', delimiter: ',', rowCount: length,
    startLocal: '', endLocal: '', startMs: 0, endMs: (length - 1) * 1000,
    timestamps: Array.from({ length }, (_, index) => index * 1000),
    channels: Object.keys(series).map((key, index) => ({ key, rawLabel: key, label: key, unit: /VFR/.test(key) ? '%' : /RSSI/.test(key) ? 'dB' : /temperature/.test(key) ? '°C' : /voltage/.test(key) ? 'V' : '', index, occurrence: 1, kind: 'numeric' })),
    series, summaries: [], warnings: [], schemaFingerprint: '', ...options
  }
}
function segments(parsed: ParsedLog): FlightSegment[] {
  return [{ id: 'flight', logId: parsed.hash, modelId: 'model', ordinal: 1, startMs: parsed.startMs, endMs: parsed.endMs, excluded: false, manual: false }]
}
const model: ModelProfile = {
  id: 'model', name: 'Model', normalizedName: 'model', description: '', category: 'airplane', propulsion: 'electric',
  rfProtocol: 'unknown', receiverCount: 2, receiverBatteries: [], channelSettings: {},
  flightRule: { operator: '>', threshold: 0, minimumDurationMs: 0, mergeGapMs: 0 }, rules: [], createdAt: '', updatedAt: ''
}
function event(id: string, startMs: number, endMs = startMs): DiagnosticEvent {
  return { id, logId: 'current', ruleId: id, ruleName: id, startMs, endMs, severity: 'warning', channelKeys: [id], message: id }
}
const repeated = (value: number, count = 61) => Array<number>(count).fill(value)

describe('observed flight intervals', () => {
  it('does not count gaps, reversed timestamps, excluded segments, or overlapping segments twice', () => {
    const parsed = log({ voltage: repeated(5, 8) }, { timestamps: [0, 1000, 2000, 20_000, 21_000, 20_500, 22_000, 23_000], endMs: 23_000 })
    const flight = segments(parsed)[0]
    const intervals = flightIntervals(parsed, [flight, { ...flight, id: 'overlap', startMs: 1000 }, { ...flight, excluded: true }])
    expect(intervals.reduce((sum, interval) => sum + interval.durationMs, 0)).toBe(4000)
    expect(flightIntervals(parsed, [{ ...flight, excluded: true }])).toEqual([])
  })

  it('clips observations to manually edited segment boundaries', () => {
    const parsed = log({ voltage: [5, 5, 5] })
    expect(flightIntervals(parsed, [{ ...segments(parsed)[0], startMs: 500, endMs: 1500 }]).map((interval) => interval.durationMs)).toEqual([500, 500])
  })
})

describe('incident reconstruction', () => {
  it('orders and groups observations without claiming a cause', () => {
    const parsed = log({ voltage: repeated(5) })
    const incidents = reconstructIncidents(parsed, [event('VFR low', 3000, 4000), event('voltage', 1000, 2000), event('RPM low', 40_000)], segments(parsed))
    expect(incidents).toHaveLength(2)
    expect(incidents[0].events.map((item) => item.ruleId)).toEqual(['voltage', 'VFR low'])
    expect(incidents[0].observation).toBe('voltage was recorded 2.0 s before VFR low.')
    expect(incidents[0].flightOrdinal).toBe(1)
  })

  it('does not merge across flight boundaries and omits excluded segments', () => {
    const parsed = log({ voltage: repeated(5) })
    const first = { ...segments(parsed)[0], endMs: 10_000 }
    const second = { ...first, id: 'second', ordinal: 2, startMs: 11_000, endMs: 20_000 }
    const events = [event('voltage', 9000), event('VFR low', 11_000)]
    expect(reconstructIncidents(parsed, events, [first, second])).toHaveLength(2)
    expect(reconstructIncidents(parsed, events, [first, { ...second, excluded: true }])).toHaveLength(1)
  })

  it('describes simultaneous observations without inventing an order', () => {
    const parsed = log({ voltage: repeated(5) })
    const incidents = reconstructIncidents(parsed, [event('voltage', 1000), { ...event('VFR low', 1000), severity: 'critical' }], segments(parsed))
    expect(incidents[0].observation).toContain('same recorded time')
    expect(incidents[0].severity).toBe('critical')
  })

  it('clips a continuing alert at segment boundaries and removes excluded portions', () => {
    const parsed = log({ voltage: repeated(5) })
    const first = { ...segments(parsed)[0], startMs: 0, endMs: 10_000 }
    const omitted = { ...first, id: 'omitted', ordinal: 2, startMs: 10_000, endMs: 20_000, excluded: true }
    const last = { ...first, id: 'last', ordinal: 3, startMs: 20_000, endMs: 30_000 }
    const incidents = reconstructIncidents(parsed, [event('voltage', 5000, 25_000)], [first, omitted, last])
    expect(incidents.map((incident) => [incident.startMs, incident.endMs])).toEqual([[5000, 10_000], [20_000, 25_000]])
    expect(incidents[1].observation).toContain('already active')
    const ground = reconstructIncidents(parsed, [event('voltage', 0, 10_000)], [{ ...omitted, startMs: 5000, endMs: 6000 }])
    expect(ground.map((incident) => [incident.startMs, incident.endMs])).toEqual([[0, 5000], [6000, 10_000]])
  })
})

describe('RF redundancy', () => {
  it('separates single-link weakness from simultaneous degradation', () => {
    const parsed = log({ 'RX1 VFR': [90, 20, 20, 90, 90], 'RX2 VFR': [90, 90, 20, 20, 90] })
    const result = analyzeRf(parsed, model, segments(parsed))
    expect(result.channels[0]).toMatchObject({ identity: 'RX1', observedMs: 4000, lowMs: 2000, longestLowMs: 2000 })
    expect(result.pairs[0]).toMatchObject({ firstOnlyLowMs: 1000, secondOnlyLowMs: 1000, bothLowMs: 1000, observedMs: 4000, longestBothLowMs: 1000, episodes: [{ startMs: 2000, endMs: 3000 }] })
  })

  it('excludes missing observations and does not join episodes over a logging gap', () => {
    const parsed = log({ 'VFR 2.4G': [20, 20, null, 20, 20, 20, 20], 'VFR 900M': [20, 20, 20, 20, 20, 20, 20] }, { timestamps: [0, 1000, 2000, 3000, 4000, 20_000, 21_000], endMs: 21_000 })
    const pair = analyzeRf(parsed, model, segments(parsed)).pairs[0]
    expect(pair.observedMs).toBe(3000)
    expect(pair.episodes).toHaveLength(3)
    expect(pair.longestBothLowMs).toBe(1000)
  })

  it('never assumes duplicate labels or mixed metrics are independent links', () => {
    const parsed = log({ a: [20, 20], b: [20, 20], c: [20, 20] })
    parsed.channels = parsed.channels.map((channel, index) => ({ ...channel, rawLabel: index < 2 ? 'RX1 VFR' : 'RX2 RSSI', label: index < 2 ? 'RX1 VFR' : 'RX2 RSSI', unit: index < 2 ? '%' : 'dB' }))
    const result = analyzeRf(parsed, model, segments(parsed))
    expect(result.pairs).toEqual([])
    expect(result.channels[0].identity).toBeUndefined()
    expect(result.channels[2].threshold).toBeUndefined()
  })

  it('uses explicit display names and configured RSSI thresholds', () => {
    const parsed = log({ RSSI: [34, 34], 'RSSI duplicate': [90, 90] })
    const configured: ModelProfile = { ...model, channelSettings: { RSSI: { label: 'RX1 RSSI' }, 'RSSI duplicate': { label: 'RX2 RSSI' } }, rules: [{ id: 'low', name: 'low', kind: 'threshold', channelKeys: ['RSSI', 'RSSI duplicate'], aggregation: 'all', operator: '<', value: 35, severity: 'warning', minimumDurationMs: 0, hysteresis: 2, enabled: true }] }
    expect(analyzeRf(parsed, configured, segments(parsed)).pairs[0].firstOnlyLowMs).toBe(1000)
  })

  it('does not treat an aggregate receiver and one of its bands as independent', () => {
    const parsed = log({ 'RX1 VFR': [20, 20], 'RX1 VFR 2.4G': [90, 90] })
    expect(analyzeRf(parsed, model, segments(parsed)).pairs).toEqual([])
  })

  it('rejects intervals ending in invalid frame-rate values', () => {
    const parsed = log({ 'RX1 VFR': [20, 120, 20], 'RX2 VFR': [20, 20, 20] })
    expect(analyzeRf(parsed, model, segments(parsed)).pairs[0].observedMs).toBe(0)
  })
})

describe('matched historical comparisons', () => {
  it('matches raw operating ranges and excludes other throttle settings', () => {
    const parsed = log({ Throttle: [...repeated(500, 41), ...repeated(900, 20)], 'ESC temperature': [...repeated(40, 41), ...repeated(100, 20)] })
    const band = chooseOperatingBand(parsed, segments(parsed), 'Throttle')!
    expect(band.lower).toBeLessThanOrEqual(500)
    expect(band.upper).toBeLessThan(900)
    expect(buildFlightProfile(parsed, segments(parsed), band).metrics[0].value).toBe(40)
    const unmatched = log({ Throttle: repeated(900), 'ESC temperature': repeated(80) })
    expect(buildFlightProfile(unmatched, segments(unmatched), band).metrics).toEqual([])
  })

  it('uses time weighting and refuses sparse or excluded measurements', () => {
    const parsed = log({ Throttle: repeated(500, 51), 'ESC temperature': [...repeated(40, 30), ...repeated(80, 21)] }, { timestamps: [...Array.from({ length: 30 }, (_, i) => i * 100), ...Array.from({ length: 21 }, (_, i) => 3000 + i * 1000)], endMs: 23_000 })
    const band = { channelKey: 'Throttle', label: 'Throttle', unit: '', lower: 400, upper: 600 }
    expect(buildFlightProfile(parsed, segments(parsed), band).metrics[0].value).toBe(80)
    expect(buildFlightProfile(parsed, [{ ...segments(parsed)[0], excluded: true }], band).metrics).toEqual([])
    const sparse = log({ Throttle: repeated(500), 'ESC temperature': [...repeated(40, 20), ...Array<null>(41).fill(null)] })
    expect(buildFlightProfile(sparse, segments(sparse), band).metrics).toEqual([])
  })

  it('requires three distinct earlier logs, excludes current/future logs, and detects robust changes', () => {
    const parsed = log({ Throttle: repeated(500), 'ESC temperature': repeated(70) }, { startMs: 100_000, endMs: 160_000, timestamps: Array.from({ length: 61 }, (_, i) => 100_000 + i * 1000) })
    const band = chooseOperatingBand(parsed, segments(parsed))!
    const current = buildFlightProfile(parsed, segments(parsed), band)
    const previous = [39, 40, 41].map((value, index) => ({ ...current, logId: `old-${index}`, startMs: index, metrics: current.metrics.map((metric) => ({ ...metric, value })) }))
    expect(compareFlightHistory(current, [previous[0], previous[0], previous[1], current, { ...previous[2], startMs: 200_000 }], parsed.channels)).toEqual([])
    const comparison = compareFlightHistory(current, previous, parsed.channels)[0]
    expect(comparison).toMatchObject({ current: 70, baseline: 40, unusual: true, historicalLogs: 3, lower: 35, upper: 45 })
    expect(compareFlightHistory({ ...current, metrics: current.metrics.map((metric) => ({ ...metric, value: 44 })) }, previous, parsed.channels)[0].unusual).toBe(false)
  })

  it('does not compare mismatched control units or very short recordings', () => {
    const parsed = log({ Throttle: [500, 500], 'ESC temperature': [70, 70] })
    expect(chooseOperatingBand(parsed, segments(parsed))).toBeUndefined()
    const longer = log({ Throttle: repeated(500), 'ESC temperature': repeated(70) })
    expect(buildFlightProfile(longer, segments(longer), { channelKey: 'Throttle', label: 'Throttle', unit: '%', lower: 400, upper: 600 }).metrics).toEqual([])
  })
})

describe('diagnostic continuity and hysteresis', () => {
  const rule: DiagnosticRule = { id: 'low', name: 'Voltage low', kind: 'threshold', channelKeys: ['voltage'], aggregation: 'any', operator: '<', value: 5, severity: 'warning', minimumDurationMs: 1000, hysteresis: 0.2, enabled: true }
  it('holds an alert until recovery clears the hysteresis margin', () => {
    const parsed = log({ voltage: [4.8, 5.05, 4.9, 5.3, 5.1, 5.1] })
    expect(evaluateRules(parsed, 'log', [rule])).toMatchObject([{ startMs: 0, endMs: 2000, peakValue: 4.8 }])
  })
  it('does not count a logging gap toward minimum alert duration', () => {
    const parsed = log({ voltage: [4.8, 4.8, 5.3, 5.3, 5.3] }, { timestamps: [0, 20_000, 21_000, 22_000, 23_000] })
    expect(evaluateRules(parsed, 'log', [rule])).toEqual([])
  })
  it('resets hysteresis at missing samples and requires all configured channels', () => {
    const parsed = log({ voltage: [4.8, null, 5.05, 5.05] })
    expect(evaluateRules(parsed, 'log', [rule])).toEqual([])
    expect(evaluateRules(log({ voltage: [4.8, 4.8] }), 'log', [{ ...rule, aggregation: 'all', channelKeys: ['voltage', 'absent'] }])).toEqual([])
  })
})

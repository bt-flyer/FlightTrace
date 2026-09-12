import type { ChannelDefinition, FlightSegment, ParsedLog } from '../types'
import { flightIntervals, median, observedValue, weightedMedian } from './insightSamples'
import { channelQuantity } from './units'

export const HISTORY_LIMIT = 12
export const MIN_HISTORY_LOGS = 3
const MIN_OBSERVED_MS = 10_000

export interface OperatingBand {
  channelKey: string
  label: string
  unit: string
  lower: number
  upper: number
}
export interface FlightMetric { channelKey: string; value: number; observedMs: number; coverage: number }
export interface FlightProfile { logId: string; startMs: number; metrics: FlightMetric[] }
export interface HistoricalComparison {
  channelKey: string
  current: number
  baseline: number
  lower: number
  upper: number
  historicalLogs: number
  observedMs: number
  unusual: boolean
}

function niceWidth(range: number): number {
  const rough = range / 5
  const power = 10 ** Math.floor(Math.log10(rough))
  return [1, 2, 5, 10].map((factor) => factor * power).find((width) => width >= rough) ?? rough
}

export function chooseOperatingBand(parsed: ParsedLog, flights: FlightSegment[], flightChannelKey?: string): OperatingBand | undefined {
  const channels = parsed.channels.filter((channel) => channel.kind === 'numeric' && /throttle|\brpm\b/i.test(channel.rawLabel))
  const candidates = [...channels].sort((a, b) => Number(b.key === flightChannelKey) - Number(a.key === flightChannelKey) || Number(/throttle/i.test(b.rawLabel)) - Number(/throttle/i.test(a.rawLabel)))
  const intervals = flightIntervals(parsed, flights)
  for (const channel of candidates) {
    const samples = intervals.flatMap((interval) => {
      const value = observedValue(parsed, channel.key, interval.index)
      return value === undefined ? [] : [{ value, weight: interval.durationMs, index: interval.index }]
    })
    if (samples.length < 10) continue
    const min = samples.reduce((value, sample) => Math.min(value, sample.value), Infinity)
    const max = samples.reduce((value, sample) => Math.max(value, sample.value), -Infinity)
    // A fixed control is still useful if its scale is known from a nonzero value.
    const width = niceWidth(Math.max(max - min, Math.abs(max) * 0.2, 1))
    const bands = new Map<number, number>()
    for (const sample of samples) {
      const bucket = Math.floor(sample.value / width)
      if (Math.floor(parsed.series[channel.key][sample.index + 1]! / width) !== bucket) continue
      bands.set(bucket, (bands.get(bucket) ?? 0) + sample.weight)
    }
    const best = [...bands].sort((a, b) => b[1] - a[1])[0]
    if (!best || best[1] < MIN_OBSERVED_MS) continue
    return { channelKey: channel.key, label: channel.label, unit: channel.unit, lower: best[0] * width, upper: (best[0] + 1) * width }
  }
  return undefined
}

function comparable(channel: ChannelDefinition): boolean {
  if (channel.kind !== 'numeric') return false
  return channelQuantity(channel) === 'temperature' || /^(v|a|rpm|db|dbm|%)$/i.test(channel.unit.trim()) && /volt|batt|rxbt|vfas|bec|lipo|current|curr|\brpm\b|\brssi\b|\bvfr\b/i.test(channel.rawLabel)
}

export function buildFlightProfile(parsed: ParsedLog, flights: FlightSegment[], band: OperatingBand): FlightProfile {
  const profile: FlightProfile = { logId: parsed.hash, startMs: parsed.startMs, metrics: [] }
  const control = parsed.channels.find((channel) => channel.key === band.channelKey && channel.unit === band.unit)
  if (!control) return profile
  const intervals = flightIntervals(parsed, flights).filter((interval) => {
    const value = observedValue(parsed, band.channelKey, interval.index)
    const next = parsed.series[band.channelKey][interval.index + 1]
    return value !== undefined && next !== null && value >= band.lower && value < band.upper && next >= band.lower && next < band.upper
  })
  const totalMs = intervals.reduce((sum, interval) => sum + interval.durationMs, 0)
  if (totalMs < MIN_OBSERVED_MS || intervals.length < 10) return profile
  for (const channel of parsed.channels.filter((item) => comparable(item) && item.key !== control.key)) {
    const samples = intervals.flatMap((interval) => {
      const value = observedValue(parsed, channel.key, interval.index)
      const next = parsed.series[channel.key][interval.index + 1]
      if (value === undefined || next == null || (/^v$/i.test(channel.unit) && (value <= 0 || next <= 0)) || (/\bvfr\b/i.test(channel.rawLabel) && (value < 0 || value > 100 || next < 0 || next > 100))) return []
      return [{ value, weight: interval.durationMs }]
    })
    const observedMs = samples.reduce((sum, sample) => sum + sample.weight, 0)
    const coverage = observedMs / totalMs
    if (samples.length < 10 || observedMs < MIN_OBSERVED_MS || coverage < 0.8) continue
    profile.metrics.push({ channelKey: channel.key, value: weightedMedian(samples), observedMs, coverage })
  }
  return profile
}

function minimumDifference(channel: ChannelDefinition, baseline: number): number {
  if (channelQuantity(channel) === 'temperature') return /f/i.test(channel.unit) ? 9 : 5
  if (/\bvfr\b/i.test(channel.rawLabel)) return 10
  if (/\brssi\b/i.test(channel.rawLabel)) return 5
  if (/^v$/i.test(channel.unit)) return Math.max(0.1, Math.abs(baseline) * 0.03)
  if (/\brpm\b/i.test(channel.rawLabel)) return Math.max(200, Math.abs(baseline) * 0.1)
  return Math.max(1, Math.abs(baseline) * 0.15)
}

export function compareFlightHistory(current: FlightProfile, history: FlightProfile[], channels: ChannelDefinition[]): HistoricalComparison[] {
  const earlier = [...new Map(history.filter((profile) => profile.logId !== current.logId && profile.startMs < current.startMs).map((profile) => [profile.logId, profile])).values()]
  return current.metrics.flatMap((metric) => {
    const channel = channels.find((item) => item.key === metric.channelKey)
    const values = earlier.flatMap((profile) => profile.metrics.filter((item) => item.channelKey === metric.channelKey).map((item) => item.value))
    if (!channel || values.length < MIN_HISTORY_LOGS) return []
    const baseline = median(values)
    const spread = Math.max(3 * 1.4826 * median(values.map((value) => Math.abs(value - baseline))), minimumDifference(channel, baseline))
    const isVfr = /\bvfr\b/i.test(channel.rawLabel)
    const lower = isVfr || /^v$/i.test(channel.unit) ? Math.max(0, baseline - spread) : baseline - spread
    const upper = isVfr ? Math.min(100, baseline + spread) : baseline + spread
    return [{ channelKey: metric.channelKey, current: metric.value, baseline, lower, upper, historicalLogs: values.length, observedMs: metric.observedMs, unusual: metric.value < lower || metric.value > upper }]
  }).sort((a, b) => Number(b.unusual) - Number(a.unusual) || a.channelKey.localeCompare(b.channelKey))
}

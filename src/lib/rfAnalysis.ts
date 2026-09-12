import type { ChannelDefinition, FlightSegment, ModelProfile, ParsedLog } from '../types'
import { flightIntervals, observedValue } from './insightSamples'

export interface RfChannel {
  channelKey: string
  label: string
  metric: 'VFR' | 'RSSI'
  receiver?: string
  band?: string
  identity?: string
  threshold?: number
  observedMs: number
  lowMs: number
  longestLowMs: number
}

export interface RfPair {
  firstKey: string
  secondKey: string
  observedMs: number
  firstOnlyLowMs: number
  secondOnlyLowMs: number
  bothLowMs: number
  longestBothLowMs: number
  episodes: Array<{ startMs: number; endMs: number }>
}

export interface RfAnalysis { channels: RfChannel[]; pairs: RfPair[]; flightMs: number }

function describeChannel(channel: ChannelDefinition, model: ModelProfile): RfChannel | undefined {
  if (channel.kind !== 'numeric') return undefined
  const label = model.channelSettings[channel.key]?.label || channel.label
  const metricText = `${channel.rawLabel} ${label}`
  const metric = /\bvfr\b/i.test(metricText) ? 'VFR' : /\brssi\b/i.test(metricText) ? 'RSSI' : undefined
  if (!metric) return undefined
  const receiver = label.match(/\b(?:rx|receiver)\s*[-#]?\s*(\d+)\b/i)?.[1]
  const bandMatch = label.match(/\b(2\.?4)\s*g(?:hz)?\b|\b(900|868|915)\s*m(?:hz)?\b/i)
  const band = bandMatch ? bandMatch[1] ? '2.4 GHz' : `${bandMatch[2]} MHz` : undefined
  const identity = receiver || band ? [receiver ? `RX${receiver}` : '', band].filter(Boolean).join(' · ') : undefined
  const thresholds = model.rules.filter((rule) => rule.enabled && rule.kind === 'threshold' && rule.channelKeys.includes(channel.key) && (rule.operator === '<' || rule.operator === '<=') && rule.value !== undefined).map((rule) => rule.value!)
  const validUnit = metric === 'VFR' ? channel.unit.trim() === '%' : /^(db|dbm)?$/i.test(channel.unit.trim())
  const threshold = validUnit ? thresholds.length ? Math.max(...thresholds) : metric === 'VFR' ? 50 : undefined : undefined
  return { channelKey: channel.key, label, metric, receiver, band, identity, threshold, observedMs: 0, lowMs: 0, longestLowMs: 0 }
}

export function analyzeRf(parsed: ParsedLog, model: ModelProfile, flights: FlightSegment[]): RfAnalysis {
  const channels = parsed.channels.flatMap((channel) => { const rf = describeChannel(channel, model); return rf ? [rf] : [] })
  // Duplicate labels do not establish independent receivers or bands.
  const identities = channels.map((channel) => `${channel.metric}:${channel.identity}`)
  channels.forEach((channel) => {
    if (identities.filter((identity) => identity === `${channel.metric}:${channel.identity}`).length > 1) channel.identity = undefined
  })
  const intervals = flightIntervals(parsed, flights)
  const validValue = (channel: RfChannel, index: number) => {
    const value = observedValue(parsed, channel.channelKey, index)
    const next = parsed.series[channel.channelKey]?.[index + 1]
    return value === undefined || (channel.metric === 'VFR' && (value < 0 || value > 100 || next == null || next < 0 || next > 100)) ? undefined : value
  }
  for (const channel of channels) {
    let run = 0
    let previousEnd = -Infinity
    for (const interval of intervals) {
      const value = validValue(channel, interval.index)
      if (value === undefined) { run = 0; continue }
      channel.observedMs += interval.durationMs
      if (channel.threshold !== undefined && value < channel.threshold) {
        channel.lowMs += interval.durationMs
        run = (previousEnd === interval.startMs ? run : 0) + interval.durationMs
        channel.longestLowMs = Math.max(channel.longestLowMs, run)
      } else run = 0
      previousEnd = interval.endMs
    }
  }
  const pairs: RfPair[] = []
  channels.forEach((first, firstIndex) => {
    for (const second of channels.slice(firstIndex + 1)) {
      const independent = (first.receiver && second.receiver && first.receiver !== second.receiver) || (first.band && second.band && first.band !== second.band)
      if (!first.identity || !second.identity || !independent || first.metric !== second.metric || first.threshold === undefined || second.threshold === undefined) continue
      const pair: RfPair = { firstKey: first.channelKey, secondKey: second.channelKey, observedMs: 0, firstOnlyLowMs: 0, secondOnlyLowMs: 0, bothLowMs: 0, longestBothLowMs: 0, episodes: [] }
      for (const interval of intervals) {
        const a = validValue(first, interval.index)
        const b = validValue(second, interval.index)
        if (a === undefined || b === undefined) continue
        pair.observedMs += interval.durationMs
        const aLow = a < first.threshold
        const bLow = b < second.threshold
        if (aLow && !bLow) pair.firstOnlyLowMs += interval.durationMs
        if (bLow && !aLow) pair.secondOnlyLowMs += interval.durationMs
        if (aLow && bLow) {
          pair.bothLowMs += interval.durationMs
          const previous = pair.episodes.at(-1)
          if (previous?.endMs === interval.startMs) previous.endMs = interval.endMs
          else pair.episodes.push({ startMs: interval.startMs, endMs: interval.endMs })
          const episode = pair.episodes.at(-1)!
          pair.longestBothLowMs = Math.max(pair.longestBothLowMs, episode.endMs - episode.startMs)
        }
      }
      pairs.push(pair)
    }
  })
  return { channels, pairs, flightMs: intervals.reduce((sum, interval) => sum + interval.durationMs, 0) }
}

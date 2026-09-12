import type { DiagnosticEvent, FlightSegment, ParsedLog, Severity } from '../types'
import { continuityLimit } from './insightSamples'

export interface Incident {
  id: string
  startMs: number
  endMs: number
  flightOrdinal?: number
  severity: Severity
  events: Array<DiagnosticEvent & { continued?: boolean }>
  channelKeys: string[]
  observation: string
}

/** Proximity groups observations; it does not establish a shared cause. */
export function reconstructIncidents(parsed: ParsedLog, events: DiagnosticEvent[], flights: FlightSegment[]): Incident[] {
  const incidents: Incident[] = []
  const ranks: Record<Severity, number> = { info: 0, warning: 1, critical: 2 }
  const mergeMs = Math.min(3000, continuityLimit(parsed))
  const intervals = flights.filter((flight) => !flight.excluded)
  const boundaries = [...new Set(flights.flatMap((flight) => [flight.startMs, flight.endMs]))].sort((a, b) => a - b)
  const observations: Incident['events'] = events.flatMap((event) => {
    const cuts = [event.startMs, ...boundaries.filter((time) => time > event.startMs && time < event.endMs), event.endMs]
    return cuts.slice(0, -1).flatMap((startMs, index) => {
      const endMs = cuts[index + 1]
      const midpoint = startMs + (endMs - startMs) / 2
      if (flights.some((flight) => flight.excluded && midpoint >= flight.startMs && midpoint <= flight.endMs)) return []
      return [{ ...event, id: `${event.id}:${index}`, startMs, endMs, continued: startMs > event.startMs }]
    })
  })
  let previousScope: string | undefined
  for (const event of observations.sort((a, b) => a.startMs - b.startMs || a.ruleName.localeCompare(b.ruleName))) {
    const midpoint = event.startMs + (event.endMs - event.startMs) / 2
    const flight = intervals.find((item) => midpoint >= item.startMs && midpoint <= item.endMs)
    const scope = flight?.id ?? `outside:${boundaries.filter((time) => time <= midpoint).length}`
    const previous = incidents.at(-1)
    const keys = event.channelKeys.filter((key) => parsed.channels.some((channel) => channel.key === key))
    // Gap rules name every channel, but are not evidence of a fault on every sensor.
    const isGap = /second gap$/.test(event.message)
    if (previous && previousScope === scope && event.startMs - previous.endMs <= mergeMs) {
      previous.events.push(event)
      previous.endMs = Math.max(previous.endMs, event.endMs)
      previous.channelKeys = [...new Set([...previous.channelKeys, ...(isGap ? [] : keys)])]
      if (ranks[event.severity] > ranks[previous.severity]) previous.severity = event.severity
    } else incidents.push({
      id: event.id, startMs: event.startMs, endMs: event.endMs, flightOrdinal: flight?.ordinal,
      severity: event.severity, events: [event], channelKeys: isGap ? [] : keys, observation: ''
    })
    previousScope = scope
  }
  const contextKeys = parsed.channels.filter((channel) => channel.kind === 'numeric' && /throttle|\brpm\b|rx.?batt|rxbt|\bvfr\b|\brssi\b/i.test(channel.rawLabel)).map((channel) => channel.key)
  for (const incident of incidents) {
    const distinct = [...new Set(incident.events.map((event) => event.ruleName))]
    const first = incident.events[0]
    const later = incident.events.find((event) => event.startMs > first.startMs && event.ruleName !== first.ruleName)
    incident.observation = first.continued ? `${first.ruleName} was already active at the start of this segment.` : later
      ? `${first.ruleName} was recorded ${((later.startMs - first.startMs) / 1000).toFixed(1)} s before ${later.ruleName}.`
      : distinct.length > 1 ? `${distinct.length} different alerts began at the same recorded time.`
        : `${first.ruleName} was recorded${incident.events.length > 1 ? ` ${incident.events.length} times in this episode` : ''}.`
    incident.channelKeys = [...new Set([...incident.channelKeys, ...contextKeys])]
  }
  return incidents
}

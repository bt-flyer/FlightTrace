import type { FlightSegment, ParsedLog } from '../types'
import { medianCadence } from './statistics'

export interface SampleInterval { index: number; startMs: number; endMs: number; durationMs: number }

export function continuityLimit(parsed: ParsedLog): number {
  return Math.max(1000, medianCadence(parsed.timestamps) * 4)
}

/** Only observed, forward intervals inside included flight segments contribute. */
export function flightIntervals(parsed: ParsedLog, flights: FlightSegment[]): SampleInterval[] {
  const ranges: Array<{ startMs: number; endMs: number }> = []
  for (const flight of flights.filter((item) => !item.excluded && item.endMs > item.startMs).sort((a, b) => a.startMs - b.startMs)) {
    const previous = ranges.at(-1)
    if (previous && flight.startMs <= previous.endMs) previous.endMs = Math.max(previous.endMs, flight.endMs)
    else ranges.push({ startMs: flight.startMs, endMs: flight.endMs })
  }
  const limit = continuityLimit(parsed)
  const intervals: SampleInterval[] = []
  let latestEnd = -Infinity
  for (let index = 0; index < parsed.timestamps.length - 1; index += 1) {
    const start = parsed.timestamps[index]
    const end = parsed.timestamps[index + 1]
    if (start < latestEnd || end <= start || end - start > limit) {
      latestEnd = Math.max(latestEnd, start)
      continue
    }
    latestEnd = end
    for (const range of ranges) {
      const startMs = Math.max(start, range.startMs)
      const endMs = Math.min(end, range.endMs)
      if (endMs > startMs) intervals.push({ index, startMs, endMs, durationMs: endMs - startMs })
    }
  }
  return intervals
}

export function observedValue(parsed: ParsedLog, key: string, index: number): number | undefined {
  const values = parsed.series[key]
  const value = values?.[index]
  const next = values?.[index + 1]
  return typeof value === 'number' && Number.isFinite(value) && typeof next === 'number' && Number.isFinite(next) ? value : undefined
}

export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length ? sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2 : 0
}

export function weightedMedian(samples: Array<{ value: number; weight: number }>): number {
  const sorted = [...samples].sort((a, b) => a.value - b.value)
  const halfway = sorted.reduce((sum, sample) => sum + sample.weight, 0) / 2
  let accumulated = 0
  for (const sample of sorted) {
    accumulated += sample.weight
    if (accumulated >= halfway) return sample.value
  }
  return 0
}

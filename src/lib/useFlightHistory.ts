import { useEffect, useMemo, useState } from 'react'
import { db } from '../db'
import type { FlightRule, FlightSegment, ParsedLog } from '../types'
import { detectFlights } from './analysis'
import { buildFlightProfile, chooseOperatingBand, compareFlightHistory, HISTORY_LIMIT, type FlightProfile } from './historyAnalysis'
import { rawLogBlob } from './rawLog'
import { parseTelemetryFile } from './workerClient'

interface HistoryState {
  key: string
  status: 'loading' | 'ready' | 'error'
  profiles: FlightProfile[]
  scanned: number
  total: number
  skipped: number
}

export function useFlightHistory(parsed: ParsedLog, flights: FlightSegment[], modelId: string, flightRule: FlightRule) {
  const ruleJson = JSON.stringify(flightRule)
  const band = useMemo(() => chooseOperatingBand(parsed, flights, flightRule.channelKey), [parsed, flights, flightRule.channelKey])
  const current = useMemo(() => band ? buildFlightProfile(parsed, flights, band) : undefined, [parsed, flights, band])
  const key = JSON.stringify([parsed.hash, modelId, ruleJson, band, flights.map((flight) => [flight.startMs, flight.endMs, flight.excluded])])
  const [state, setState] = useState<HistoryState>()

  useEffect(() => {
    if (!band || !current?.metrics.length) return
    let cancelled = false
    let cancelParse: (() => void) | undefined
    void (async () => {
      const next: HistoryState = { key, status: 'loading', profiles: [], scanned: 0, total: 0, skipped: 0 }
      try {
        const logs = await db.logs.where('[modelId+startLocal]').between([modelId, ''], [modelId, parsed.startLocal], true, false).reverse().limit(HISTORY_LIMIT).toArray()
        if (cancelled) return
        next.total = logs.length
        setState({ ...next })
        for (const log of logs) {
          try {
            const stored = await db.flights.where('logId').equals(log.id).toArray()
            if (cancelled) return
            const request = parseTelemetryFile(rawLogBlob(log.rawBlob), log.fileName)
            cancelParse = request.cancel
            const result = await request.promise
            if (cancelled) return
            const segments = stored.some((flight) => flight.manual || flight.excluded) ? stored : detectFlights(result, modelId, log.id, JSON.parse(ruleJson) as FlightRule)
            next.profiles = [...next.profiles, buildFlightProfile(result, segments, band)]
          } catch {
            if (cancelled) return
            next.skipped += 1
          }
          next.scanned += 1
          setState({ ...next })
        }
        next.status = 'ready'
        setState({ ...next })
      } catch {
        if (!cancelled) setState({ ...next, status: 'error' })
      }
    })()
    return () => { cancelled = true; cancelParse?.() }
  }, [band, current, key, modelId, parsed.startLocal, ruleJson])

  const active = state?.key === key ? state : undefined
  const comparisons = useMemo(() => current && active?.status === 'ready' ? compareFlightHistory(current, active.profiles, parsed.channels) : [], [current, active, parsed.channels])
  return { band, current, comparisons, status: active?.status ?? 'loading', scanned: active?.scanned ?? 0, total: active?.total ?? 0, skipped: active?.skipped ?? 0 }
}

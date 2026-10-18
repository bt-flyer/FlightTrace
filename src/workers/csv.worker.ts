/// <reference lib="webworker" />
import Papa from 'papaparse'
import { createSHA256 } from 'hash-wasm'
import { isTimestampLabel, normalizeToken, parseHeader } from '../lib/channels'
import { deriveLipoTelemetry } from '../lib/lipoTelemetry'
import { combinedGpsChannels, parseGpsCell } from '../lib/gps'
import { medianCadence, summarizeChannel } from '../lib/statistics'
import type { ChannelDefinition, ParsedLog, WorkerRequest, WorkerResponse } from '../types'

const context: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope

function post(message: WorkerResponse) {
  context.postMessage(message)
}

async function hashBlob(blob: Blob, requestId: string): Promise<string> {
  const hasher = await createSHA256()
  const reader = blob.stream().getReader()
  let processed = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    hasher.update(value)
    processed += value.byteLength
    post({ type: 'progress', requestId, progress: blob.size ? (processed / blob.size) * 0.2 : 0.2, stage: 'Fingerprinting' })
  }
  return hasher.digest('hex')
}

function parseFloatingTimestamp(dateValue: string | undefined, timeValue?: string): { ms: number; local: string } | null {
  const combined = timeValue === undefined ? (dateValue ?? '').trim() : `${dateValue ?? ''}T${timeValue}`.trim()
  const match = combined.match(/^(\d{4})[-/]?(\d{2})[-/]?(\d{2})[T\s,]+(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?/)
  if (!match) return null
  const [, year, month, day, hour, minute, second, fraction = '0'] = match
  const milliseconds = Number(fraction.padEnd(3, '0'))
  const ms = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second), milliseconds)
  return { ms, local: `${year}-${month}-${day}T${hour}:${minute}:${second}.${String(milliseconds).padStart(3, '0')}` }
}

function stableSchemaFingerprint(channels: ChannelDefinition[]): string {
  const signature = channels.map((channel) => channel.key).sort().join('\n')
  let hash = 2166136261
  for (let index = 0; index < signature.length; index += 1) {
    hash ^= signature.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return `schema-${(hash >>> 0).toString(16).padStart(8, '0')}`
}

async function parseRows(file: File | Blob, requestId: string): Promise<{ rows: string[][]; delimiter: string; errors: string[] }> {
  return new Promise((resolve, reject) => {
    const rows: string[][] = []
    const errors: string[] = []
    let delimiter = ','
    Papa.parse<string[]>(file as File, {
      delimiter: '',
      skipEmptyLines: 'greedy',
      chunkSize: 1024 * 1024,
      chunk(results) {
        delimiter = results.meta.delimiter || delimiter
        rows.push(...results.data)
        for (const error of results.errors) {
          if (errors.length < 25) errors.push(`Row ${error.row ?? '?'}: ${error.message}`)
        }
        const cursor = results.meta.cursor ?? 0
        post({ type: 'progress', requestId, progress: 0.2 + (file.size ? cursor / file.size : 1) * 0.75, stage: 'Parsing telemetry' })
      },
      complete() {
        resolve({ rows, delimiter, errors })
      },
      error(error) {
        reject(error)
      }
    })
  })
}

async function parseLog(file: File | Blob, fileName: string, requestId: string): Promise<ParsedLog> {
  const hash = await hashBlob(file, requestId)
  const { rows, delimiter, errors } = await parseRows(file, requestId)
  if (rows.length < 2) throw new Error('The CSV does not contain a header and telemetry rows.')

  const header = rows[0].map((value) => String(value ?? '').trim())
  if (header.at(-1) === '') {
    header.pop()
    for (const row of rows.slice(1)) {
      if (row.length && String(row.at(-1) ?? '').trim() === '') row.pop()
    }
  }

  const normalizedHeaders = header.map(normalizeToken)
  const dateIndex = normalizedHeaders.indexOf('date')
  const timeIndex = normalizedHeaders.indexOf('time')
  const timestampIndex = normalizedHeaders.findIndex((value) => value === 'timestamp' || value === 'datetime')
  if (timestampIndex < 0 && (dateIndex < 0 || timeIndex < 0)) {
    throw new Error('No usable timestamp was detected. Map a Date/Time or Timestamp column before importing.')
  }

  const occurrences = new Map<string, number>()
  const channels = header
    .map((value, index) => parseHeader(value, index, occurrences))
    .filter((channel) => !isTimestampLabel(channel.rawLabel))
  const gpsChannels = combinedGpsChannels(channels)
  channels.push(...gpsChannels)
  const gpsKeys = new Map(gpsChannels.map((channel, index) => [channel.key, index % 2]))
  const series = Object.fromEntries(channels.map((channel) => [channel.key, [] as Array<number | null>]))
  const nonNumeric = new Map<string, number>()
  const timestamps: number[] = []
  const timestampLabels: string[] = []
  let malformedWidths = 0
  let invalidTimestamps = 0

  for (const row of rows.slice(1)) {
    if (row.length !== header.length) malformedWidths += 1
    const timestamp = timestampIndex >= 0
      ? parseFloatingTimestamp(row[timestampIndex])
      : parseFloatingTimestamp(row[dateIndex], row[timeIndex])
    if (!timestamp) {
      invalidTimestamps += 1
      continue
    }
    timestamps.push(timestamp.ms)
    timestampLabels.push(timestamp.local)
    for (const channel of channels) {
      const raw = String(row[channel.index] ?? '').trim()
      const coordinateIndex = gpsKeys.get(channel.key)
      const numeric = coordinateIndex === undefined
        ? raw === '' ? null : Number(raw)
        : parseGpsCell(raw)?.[coordinateIndex] ?? null
      if (raw !== '' && !Number.isFinite(numeric)) nonNumeric.set(channel.key, (nonNumeric.get(channel.key) ?? 0) + 1)
      series[channel.key].push(Number.isFinite(numeric) ? numeric : null)
    }
  }

  if (!timestamps.length) throw new Error('No rows contained a valid timestamp.')
  const cadence = medianCadence(timestamps)
  const summaries = channels.map((channel) => summarizeChannel(channel.key, series[channel.key], timestamps, cadence))
  for (const channel of channels) {
    const summary = summaries.find((candidate) => candidate.channelKey === channel.key)
    if (!summary?.count) channel.kind = 'empty'
    else if ((nonNumeric.get(channel.key) ?? 0) > summary.count) channel.kind = 'text'
  }

  for (const derived of deriveLipoTelemetry(channels, series, timestamps.length)) {
    channels.push(derived.channel)
    series[derived.channel.key] = derived.values
    summaries.push(summarizeChannel(derived.channel.key, derived.values, timestamps, cadence))
  }

  const warnings = [...errors]
  if (malformedWidths) warnings.push(`${malformedWidths} row(s) did not match the header width; absent cells were retained as missing values.`)
  if (invalidTimestamps) warnings.push(`${invalidTimestamps} row(s) with invalid timestamps were skipped.`)
  const duplicateLabels = channels.filter((channel) => channel.occurrence > 1).length
  if (duplicateLabels) warnings.push(`${duplicateLabels} duplicate channel label(s) were kept distinct by occurrence.`)
  if (timestamps.some((value, index) => index > 0 && value < timestamps[index - 1])) {
    warnings.push('Out-of-order timestamps were preserved and excluded from duration weighting where necessary.')
  }

  post({ type: 'progress', requestId, progress: 1, stage: 'Finalizing' })
  return {
    hash,
    fileName,
    delimiter,
    rowCount: timestamps.length,
    startLocal: timestampLabels[0],
    endLocal: timestampLabels[timestampLabels.length - 1],
    startMs: timestamps[0],
    endMs: timestamps[timestamps.length - 1],
    timestamps,
    channels,
    series,
    summaries,
    warnings,
    schemaFingerprint: stableSchemaFingerprint(channels)
  }
}

context.addEventListener('message', async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data
  if (request.type !== 'parse') return
  try {
    const result = await parseLog(request.file, request.fileName, request.requestId)
    post({ type: 'result', requestId: request.requestId, result })
  } catch (error) {
    post({ type: 'error', requestId: request.requestId, error: error instanceof Error ? error.message : String(error) })
  }
})

export {}

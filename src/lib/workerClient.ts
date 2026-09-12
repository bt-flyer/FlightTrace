import type { ParsedLog, WorkerRequest, WorkerResponse } from '../types'
import CsvWorker from '../workers/csv.worker?worker&inline'

export interface ParseProgress {
  progress: number
  stage: string
}

export function parseTelemetryFile(
  file: File | Blob,
  fileName: string,
  onProgress?: (progress: ParseProgress) => void
): { promise: Promise<ParsedLog>; cancel: () => void } {
  // Keep the parser with the application code. An open tab must not depend on
  // a hashed worker URL that a later GitHub Pages deployment can remove.
  const worker = new CsvWorker()
  const requestId = crypto.randomUUID()
  let settled = false
  let rejectPromise: (reason?: unknown) => void = () => undefined
  const promise = new Promise<ParsedLog>((resolve, reject) => {
    rejectPromise = reject
    worker.addEventListener('message', (event: MessageEvent<WorkerResponse>) => {
      const response = event.data
      if (response.requestId !== requestId) return
      if (response.type === 'progress') onProgress?.({ progress: response.progress, stage: response.stage })
      if (response.type === 'result') {
        settled = true
        worker.terminate()
        resolve(response.result)
      }
      if (response.type === 'error') {
        settled = true
        worker.terminate()
        reject(new Error(response.error))
      }
    })
    worker.addEventListener('error', (event) => {
      // Report parser startup failures in the import UI instead of the global
      // error boundary, which would hide access to the user's stored logs.
      event.preventDefault()
      settled = true
      worker.terminate()
      reject(new Error(event.message || 'The log parser could not start. Reload FlightTrace, then select your CSV again. Your saved logs remain in this browser.'))
    })
    const request: WorkerRequest = { type: 'parse', requestId, file, fileName }
    worker.postMessage(request)
  })
  return {
    promise,
    cancel: () => {
      if (settled) return
      settled = true
      worker.terminate()
      rejectPromise(new DOMException('Import cancelled.', 'AbortError'))
    }
  }
}

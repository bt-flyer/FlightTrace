import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const serviceWorkerTemplate = readFileSync(new URL('./src/service-worker.js', import.meta.url), 'utf8')

export default defineConfig({
  base: './',
  plugins: [react(), {
    name: 'flighttrace-service-worker',
    generateBundle(_options, bundle) {
      const hash = createHash('sha256')
      hash.update(serviceWorkerTemplate)
      for (const [fileName, output] of Object.entries(bundle).sort(([left], [right]) => left.localeCompare(right))) {
        hash.update(fileName)
        hash.update(output.type === 'chunk' ? output.code : String(output.source))
      }
      const buildId = hash.digest('hex').slice(0, 12)
      this.emitFile({
        type: 'asset',
        fileName: 'sw.js',
        source: serviceWorkerTemplate.replace('__BUILD_ID__', buildId)
      })
    }
  }],
  worker: { format: 'es' }
})

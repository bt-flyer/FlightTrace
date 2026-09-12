import { useEffect, useRef } from 'react'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'
import type { ChannelDefinition, ParsedLog } from '../types'

export const MAX_GRAPH_CHANNELS = 24

const colors = [
  '#087f70', '#a45a06', '#2563b8', '#bf3455', '#7653b9', '#387d35',
  '#087f9b', '#bc4f1b', '#a23886', '#5159b8', '#737b17', '#92578e'
]

export function TelemetryChart({ parsed, channelKeys, onCursorTimeChange, expanded = false, showPoints = false, focusRange }: { parsed: ParsedLog; channelKeys: string[]; onCursorTimeChange?: (timestamp: number) => void; expanded?: boolean; showPoints?: boolean; focusRange?: { startMs: number; endMs: number } }) {
  const hostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host || !channelKeys.length) return
    const channels = channelKeys.map((key) => parsed.channels.find((channel) => channel.key === key)).filter((channel): channel is ChannelDefinition => Boolean(channel))
    const units = [...new Set(channels.map((channel) => channel.unit || 'value'))]
    const x = parsed.timestamps.map((timestamp) => (timestamp - parsed.startMs) / 1000)
    const data: uPlot.AlignedData = [x, ...channelKeys.map((key) => parsed.series[key] ?? [])]
    const chartHeight = () => {
      if (!expanded) return 390
      const legend = host.querySelector<HTMLElement>('.u-legend')
      const legendHeight = legend ? Math.max(44, legend.offsetHeight) : 70
      return Math.max(240, host.clientHeight - legendHeight)
    }
    const options: uPlot.Options = {
      width: Math.max(320, host.clientWidth), height: chartHeight(),
      cursor: { drag: { x: true, y: false, setScale: true } },
      legend: { show: true, live: true },
      hooks: { setCursor: [(plot) => { const index = plot.cursor.idx; if (index !== null && index !== undefined) onCursorTimeChange?.(parsed.timestamps[index]) }] },
      scales: { ...Object.fromEntries(units.map((unit) => [unit, { auto: true }])), x: { time: false } },
      axes: [
        { label: 'Elapsed time (seconds)', stroke: '#516779', grid: { stroke: '#dce5ed' }, ticks: { stroke: '#a6bac9' } },
        ...units.slice(0, 3).map((unit, index) => ({ scale: unit, label: unit, side: index % 2 ? 1 : 3, stroke: colors[index], grid: { show: index === 0, stroke: '#dce5ed' }, ticks: { stroke: '#a6bac9' } } as uPlot.Axis))
      ],
      series: [
        {},
        ...channels.map((channel, index) => ({
          label: channel.label,
          scale: channel.unit || 'value',
          stroke: colors[index % colors.length],
          width: index < colors.length ? 1.6 : 1.9,
          dash: index < colors.length ? [] : [9, 5],
          spanGaps: false,
          points: { show: showPoints, size: 4 }
        }))
      ]
    }
    const chart = new uPlot(options, data, host)
    if (focusRange && focusRange.endMs > focusRange.startMs) chart.setScale('x', { min: (focusRange.startMs - parsed.startMs) / 1000, max: (focusRange.endMs - parsed.startMs) / 1000 })
    let resizeFrame = 0
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(resizeFrame)
      resizeFrame = requestAnimationFrame(() => {
        const width = Math.max(320, host.clientWidth)
        const height = chartHeight()
        if (chart.width !== width || chart.height !== height) chart.setSize({ width, height })
      })
    })
    observer.observe(host)
    return () => { observer.disconnect(); cancelAnimationFrame(resizeFrame); chart.destroy() }
  }, [channelKeys, expanded, onCursorTimeChange, parsed, showPoints, focusRange])

  if (!channelKeys.length) return <div className="empty-chart">Select at least one channel to draw a chart.</div>
  return <div className="chart-host" ref={hostRef} />
}

import { useMemo, useState } from 'react'
import { buildFlightTrack, type FlightTrackPoint } from '../lib/gps'
import { convertQuantityValue, type UnitPreferences } from '../lib/units'
import type { ParsedLog } from '../types'

const WIDTH = 1000
const HEIGHT = 590
const PADDING = 52
const MAX_RENDERED_POINTS = 1400
const TILE_SIZE = 256
const MAX_MERCATOR_LATITUDE = 85.05112878

interface MapTile { key: string; url: string; x: number; y: number }

interface MapViewport {
  zoom: number
  left: number
  top: number
  tiles: MapTile[]
}

function formatDistance(meters: number, preferences: UnitPreferences): string {
  if (preferences.distance === 'mi') return `${convertQuantityValue(meters, 'distance', 'm', 'mi').toFixed(2)} mi`
  if (preferences.distance === 'nmi') return `${convertQuantityValue(meters, 'distance', 'm', 'nmi').toFixed(2)} nmi`
  if (preferences.distance === 'km') return `${convertQuantityValue(meters, 'distance', 'm', 'km').toFixed(2)} km`
  return meters >= 1000 ? `${(meters / 1000).toFixed(2)} km` : `${Math.round(meters)} m`
}

function formatAltitude(value: number, unit?: string): string {
  return `${value.toFixed(Math.abs(value) < 100 ? 1 : 0)}${unit ? ` ${unit}` : ''}`
}

function altitudeColor(altitude: number | undefined, minimum: number | undefined, maximum: number | undefined): string {
  if (altitude === undefined || minimum === undefined || maximum === undefined) return 'hsl(172 88% 26%)'
  const ratio = maximum === minimum ? 0.5 : Math.max(0, Math.min(1, (altitude - minimum) / (maximum - minimum)))
  return `hsl(${205 - ratio * 193} 78% 35%)`
}

function thinSegment(points: FlightTrackPoint[]): FlightTrackPoint[] {
  if (points.length <= MAX_RENDERED_POINTS) return points
  const result: FlightTrackPoint[] = []
  const step = (points.length - 1) / (MAX_RENDERED_POINTS - 1)
  for (let index = 0; index < MAX_RENDERED_POINTS; index += 1) result.push(points[Math.round(index * step)])
  return result
}

function worldPosition(latitude: number, longitude: number, zoom: number) {
  const clippedLatitude = Math.max(-MAX_MERCATOR_LATITUDE, Math.min(MAX_MERCATOR_LATITUDE, latitude))
  const latitudeRadians = clippedLatitude * Math.PI / 180
  const worldSize = TILE_SIZE * 2 ** zoom
  return {
    x: (longitude + 180) / 360 * worldSize,
    y: (1 - Math.log(Math.tan(latitudeRadians) + 1 / Math.cos(latitudeRadians)) / Math.PI) / 2 * worldSize
  }
}

function mapViewport(minLatitude: number, maxLatitude: number, minLongitude: number, maxLongitude: number): MapViewport {
  let zoom = 1
  for (let candidate = 19; candidate >= 1; candidate -= 1) {
    const northwest = worldPosition(maxLatitude, minLongitude, candidate)
    const southeast = worldPosition(minLatitude, maxLongitude, candidate)
    if (southeast.x - northwest.x <= WIDTH - PADDING * 2 && southeast.y - northwest.y <= HEIGHT - PADDING * 2) {
      zoom = candidate
      break
    }
  }
  const northwest = worldPosition(maxLatitude, minLongitude, zoom)
  const southeast = worldPosition(minLatitude, maxLongitude, zoom)
  const left = (northwest.x + southeast.x - WIDTH) / 2
  const top = (northwest.y + southeast.y - HEIGHT) / 2
  const tileLimit = 2 ** zoom
  const tiles: MapTile[] = []
  const firstX = Math.floor(left / TILE_SIZE)
  const lastX = Math.floor((left + WIDTH) / TILE_SIZE)
  const firstY = Math.max(0, Math.floor(top / TILE_SIZE))
  const lastY = Math.min(tileLimit - 1, Math.floor((top + HEIGHT) / TILE_SIZE))
  for (let tileY = firstY; tileY <= lastY; tileY += 1) {
    for (let tileX = firstX; tileX <= lastX; tileX += 1) {
      const wrappedX = ((tileX % tileLimit) + tileLimit) % tileLimit
      tiles.push({
        key: `${zoom}-${tileX}-${tileY}`,
        url: `https://tile.openstreetmap.org/${zoom}/${wrappedX}/${tileY}.png`,
        x: tileX * TILE_SIZE - left,
        y: tileY * TILE_SIZE - top
      })
    }
  }
  return { zoom, left, top, tiles }
}

export function FlightPathMap({ parsed, unitPreferences }: { parsed: ParsedLog; unitPreferences: UnitPreferences }) {
  const [showBasemap, setShowBasemap] = useState(false)
  const [tileError, setTileError] = useState(false)
  const track = useMemo(() => buildFlightTrack(parsed), [parsed])
  if (!track || !track.segments.length) return null

  const viewport = mapViewport(track.minLatitude, track.maxLatitude, track.minLongitude, track.maxLongitude)
  const project = (point: FlightTrackPoint) => {
    const world = worldPosition(point.latitude, point.longitude, viewport.zoom)
    return { x: world.x - viewport.left, y: world.y - viewport.top }
  }
  const start = track.segments[0][0]
  const finishSegment = track.segments[track.segments.length - 1]
  const finish = finishSegment[finishSegment.length - 1]
  const startPosition = project(start)
  const finishPosition = project(finish)
  const hasAltitude = track.minAltitude !== undefined && track.maxAltitude !== undefined

  return <section className="analysis-panel flight-map-panel" aria-labelledby="flight-path-title">
    <div className="panel-heading flight-map-heading">
      <div><span className="eyebrow">Position trace</span><h2 id="flight-path-title">Flight path</h2><p>Route colors show altitude from low to high. GPS analysis stays on this device.</p></div>
      <div className="flight-map-stats">
        <span><small>GPS distance</small><strong>{formatDistance(track.distanceMeters, unitPreferences)}</strong></span>
        <span><small>Coordinate coverage</small><strong>{(track.coordinateCoverage * 100).toFixed(1)}%</strong></span>
        {hasAltitude && <span><small>Altitude range</small><strong>{formatAltitude(track.minAltitude!, track.channels.altitudeUnit)} – {formatAltitude(track.maxAltitude!, track.channels.altitudeUnit)}</strong></span>}
      </div>
    </div>
    <div className="flight-map-controls no-print">
      <button className="button ghost small" aria-pressed={showBasemap} onClick={() => { setTileError(false); setShowBasemap((current) => !current) }}>{showBasemap ? 'Hide street map' : 'Load street map'}</button>
      <span>{showBasemap ? 'Street tiles are loaded from OpenStreetMap.' : 'Loading the street map shares the approximate flight area with OpenStreetMap.'}</span>
    </div>
    {tileError && <p className="flight-map-error" role="status">Some map tiles could not be loaded. The recorded route is still available.</p>}
    <div className="flight-map-wrap">
      {showBasemap && <div className="flight-map-tiles" aria-hidden="true">{viewport.tiles.map((tile) => <img key={tile.key} src={tile.url} alt="" style={{ left: `${tile.x / WIDTH * 100}%`, top: `${tile.y / HEIGHT * 100}%`, width: `${TILE_SIZE / WIDTH * 100}%`, height: `${TILE_SIZE / HEIGHT * 100}%` }} onError={() => setTileError(true)} />)}<span className="flight-map-tile-shade" /></div>}
      <svg className="flight-map" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label="GPS flight path colored by altitude">
        <title>GPS flight path</title>
        <desc>The recorded flight route. Blue portions are lower altitude and red portions are higher altitude.</desc>
        <rect className={`flight-map-background${showBasemap ? ' basemap' : ''}`} width={WIDTH} height={HEIGHT} rx="14" />
        {!showBasemap && [0.2, 0.4, 0.6, 0.8].map((fraction) => <g key={fraction} className="flight-map-grid"><line x1={WIDTH * fraction} y1={0} x2={WIDTH * fraction} y2={HEIGHT} /><line x1={0} y1={HEIGHT * fraction} x2={WIDTH} y2={HEIGHT * fraction} /></g>)}
        <text className="flight-map-north" x={WIDTH - 35} y={34} textAnchor="middle">N ↑</text>
        {track.segments.map((segment, segmentIndex) => {
          const points = thinSegment(segment)
          return <g key={segmentIndex}>{points.slice(1).map((point, index) => {
            const previous = points[index]
            const from = project(previous)
            const to = project(point)
            const altitude = point.altitude === undefined || previous.altitude === undefined ? point.altitude ?? previous.altitude : (point.altitude + previous.altitude) / 2
            return <line key={`${segmentIndex}-${point.index}`} className="flight-path-segment" x1={from.x} y1={from.y} x2={to.x} y2={to.y} stroke={altitudeColor(altitude, track.minAltitude, track.maxAltitude)} />
          })}</g>
        })}
        <circle className="flight-map-marker start" cx={startPosition.x} cy={startPosition.y} r="9" />
        <text className="flight-map-marker-label" x={startPosition.x + 14} y={startPosition.y - 12}>Start</text>
        <circle className="flight-map-marker finish" cx={finishPosition.x} cy={finishPosition.y} r="9" />
        <text className="flight-map-marker-label" x={finishPosition.x + 14} y={finishPosition.y + 24}>Finish</text>
        <text className="flight-map-coordinate" x={18} y={HEIGHT - 18}>{track.minLatitude.toFixed(5)}, {track.minLongitude.toFixed(5)}</text>
        <text className="flight-map-coordinate" x={WIDTH - 18} y={HEIGHT - 18} textAnchor="end">{track.maxLatitude.toFixed(5)}, {track.maxLongitude.toFixed(5)}</text>
      </svg>
      {showBasemap && <a className="flight-map-attribution" href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap contributors</a>}
    </div>
    <div className="flight-altitude-legend" aria-label={hasAltitude ? 'Altitude color scale' : 'Altitude unavailable'}>
      {hasAltitude ? <><span>{formatAltitude(track.minAltitude!, track.channels.altitudeUnit)}</span><i /><span>{formatAltitude(track.maxAltitude!, track.channels.altitudeUnit)}</span></> : <><span>Flight path</span><i className="unavailable" /><span>Altitude unavailable</span></>}
    </div>
  </section>
}

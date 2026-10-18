import type { ChannelDefinition, ParsedLog } from '../types'

export interface GpsChannelMatch {
  latitudeKey: string
  longitudeKey: string
  altitudeKey?: string
  altitudeUnit?: string
}

export interface FlightTrackPoint {
  index: number
  timestamp: number
  latitude: number
  longitude: number
  altitude?: number
}

export interface FlightTrack {
  channels: GpsChannelMatch
  segments: FlightTrackPoint[][]
  pointCount: number
  coordinateCoverage: number
  distanceMeters: number
  minLatitude: number
  maxLatitude: number
  minLongitude: number
  maxLongitude: number
  minAltitude?: number
  maxAltitude?: number
}

type CoordinateRole = 'latitude' | 'longitude'

// FrSky logs record both decimal-degree coordinates in a single GPS cell.
export function parseGpsCell(raw: string): [number, number] | undefined {
  const match = raw.trim().match(/^([+-]?\d+(?:\.\d+)?)\s+([+-]?\d+(?:\.\d+)?)$/)
  if (!match) return undefined
  const latitude = Number(match[1])
  const longitude = Number(match[2])
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return undefined
  return [latitude, longitude]
}

export function combinedGpsChannels(channels: ChannelDefinition[]): ChannelDefinition[] {
  return channels.filter((channel) => /^gps$/i.test(channel.rawLabel.trim())).flatMap((source) =>
    ['Latitude', 'Longitude'].map((role) => ({
      key: `derived|${source.key}|${role.toLowerCase()}`,
      rawLabel: `GPS ${role}`, label: `GPS ${role}`, unit: 'deg',
      occurrence: source.occurrence, index: source.index, kind: 'numeric' as const
    }))
  )
}

const BAD_LOCATION_WORDS = /\b(home|takeoff|pilot|controller|remote|return|start|target|waypoint)\b/
const BAD_ALTITUDE_WORDS = /\b(home|takeoff|max(?:imum)?|min(?:imum)?|needed|required|limit|warning|target)\b/

function words(channel: ChannelDefinition): string {
  return `${channel.rawLabel} ${channel.label}`
    .toLocaleLowerCase()
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function scoreCoordinate(channel: ChannelDefinition, role: CoordinateRole): number {
  if (channel.kind !== 'numeric') return -Infinity
  const label = words(channel)
  const compact = label.replace(/\s+/g, '')
  const exact = role === 'latitude'
    ? new Set(['lat', 'latitude', 'gpslat', 'gpslatitude', 'positionlat', 'positionlatitude', 'aircraftlat', 'aircraftlatitude', 'aircraftlocationlat', 'aircraftlocationlatitude'])
    : new Set(['lon', 'lng', 'long', 'longitude', 'gpslon', 'gpslng', 'gpslongitude', 'positionlon', 'positionlng', 'positionlongitude', 'aircraftlon', 'aircraftlng', 'aircraftlongitude', 'aircraftlocationlon', 'aircraftlocationlng', 'aircraftlocationlongitude'])
  const token = role === 'latitude' ? /\b(lat|latitude)\b/ : /\b(lon|lng|long|longitude)\b/
  const suffix = role === 'latitude' ? /(lat|latitude)$/ : /(lon|lng|long|longitude)$/
  let score = exact.has(compact) ? 120 : token.test(label) ? 90 : suffix.test(compact) ? 65 : -Infinity
  if (!Number.isFinite(score)) return score
  if (/\b(gps|position|location|aircraft)\b/.test(label)) score += 12
  if (BAD_LOCATION_WORDS.test(label)) score -= 80
  const unit = channel.unit.toLocaleLowerCase()
  if (/deg|degree|°/.test(unit)) score += 8
  if (/rad/.test(unit)) score += 4
  return score
}

function coordinateValue(value: number | null, channel: ChannelDefinition, role: CoordinateRole): number | undefined {
  if (value === null || !Number.isFinite(value)) return undefined
  const converted = /rad/i.test(channel.unit) ? value * 180 / Math.PI : value
  const valid = role === 'latitude' ? Math.abs(converted) <= 90 : Math.abs(converted) <= 180
  return valid ? converted : undefined
}

function pairCoverage(parsed: ParsedLog, latitude: ChannelDefinition, longitude: ChannelDefinition): number {
  const latitudes = parsed.series[latitude.key] ?? []
  const longitudes = parsed.series[longitude.key] ?? []
  const limit = Math.min(parsed.timestamps.length, latitudes.length, longitudes.length)
  if (!limit) return 0
  let valid = 0
  for (let index = 0; index < limit; index += 1) {
    if (coordinateValue(latitudes[index], latitude, 'latitude') !== undefined && coordinateValue(longitudes[index], longitude, 'longitude') !== undefined) valid += 1
  }
  return valid / limit
}

function scoreAltitude(channel: ChannelDefinition): number {
  if (channel.kind !== 'numeric') return -Infinity
  const label = words(channel)
  const compact = label.replace(/\s+/g, '')
  let score = /^(alt|altitude|height|relalt|relativealt|relativealtitude|relativeheight|gpsalt|gpsaltitude|baroalt|baroaltitude)$/.test(compact)
    ? 105
    : /\b(alt|altitude|height)\b/.test(label) ? 75 : /(alt|altitude|height)$/.test(compact) ? 55 : -Infinity
  if (!Number.isFinite(score)) return score
  if (/\b(relative|rel|baro|gps|aircraft)\b/.test(label)) score += 12
  if (BAD_ALTITUDE_WORDS.test(label)) score -= 75
  if (/^(m|meter|meters|metre|metres|ft|feet|foot)$/i.test(channel.unit.trim())) score += 8
  return score
}

export function detectGpsChannels(parsed: ParsedLog): GpsChannelMatch | undefined {
  const latitudes = parsed.channels.map((channel) => ({ channel, score: scoreCoordinate(channel, 'latitude') })).filter(({ score }) => score > 0)
  const longitudes = parsed.channels.map((channel) => ({ channel, score: scoreCoordinate(channel, 'longitude') })).filter(({ score }) => score > 0)
  let best: { latitude: ChannelDefinition; longitude: ChannelDefinition; score: number } | undefined
  for (const latitude of latitudes) {
    for (const longitude of longitudes) {
      const coverage = pairCoverage(parsed, latitude.channel, longitude.channel)
      if (coverage === 0) continue
      const score = latitude.score + longitude.score + coverage * 100
      if (!best || score > best.score) best = { latitude: latitude.channel, longitude: longitude.channel, score }
    }
  }
  if (!best) return undefined
  const altitude = parsed.channels
    .map((channel) => ({ channel, score: scoreAltitude(channel) }))
    .filter(({ score, channel }) => score > 0 && (parsed.series[channel.key] ?? []).some((value) => value !== null && Number.isFinite(value)))
    .sort((a, b) => b.score - a.score)[0]?.channel
  return {
    latitudeKey: best.latitude.key,
    longitudeKey: best.longitude.key,
    altitudeKey: altitude?.key,
    altitudeUnit: altitude?.unit || undefined
  }
}

function median(values: number[]): number {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function haversineMeters(a: FlightTrackPoint, b: FlightTrackPoint): number {
  const radius = 6_371_000
  const toRadians = Math.PI / 180
  const latitudeDelta = (b.latitude - a.latitude) * toRadians
  const longitudeDelta = (b.longitude - a.longitude) * toRadians
  const latitudeA = a.latitude * toRadians
  const latitudeB = b.latitude * toRadians
  const value = Math.sin(latitudeDelta / 2) ** 2 + Math.cos(latitudeA) * Math.cos(latitudeB) * Math.sin(longitudeDelta / 2) ** 2
  return 2 * radius * Math.asin(Math.min(1, Math.sqrt(value)))
}

export function buildFlightTrack(parsed: ParsedLog): FlightTrack | undefined {
  const channels = detectGpsChannels(parsed)
  if (!channels) return undefined
  const latitudeChannel = parsed.channels.find((channel) => channel.key === channels.latitudeKey)
  const longitudeChannel = parsed.channels.find((channel) => channel.key === channels.longitudeKey)
  if (!latitudeChannel || !longitudeChannel) return undefined
  const latitudes = parsed.series[channels.latitudeKey] ?? []
  const longitudes = parsed.series[channels.longitudeKey] ?? []
  const altitudes = channels.altitudeKey ? parsed.series[channels.altitudeKey] ?? [] : []
  const points: FlightTrackPoint[] = []
  const limit = Math.min(parsed.timestamps.length, latitudes.length, longitudes.length)
  for (let index = 0; index < limit; index += 1) {
    const latitude = coordinateValue(latitudes[index], latitudeChannel, 'latitude')
    const longitude = coordinateValue(longitudes[index], longitudeChannel, 'longitude')
    if (latitude === undefined || longitude === undefined) continue
    const altitude = altitudes[index]
    points.push({ index, timestamp: parsed.timestamps[index], latitude, longitude, altitude: altitude !== null && Number.isFinite(altitude) ? altitude : undefined })
  }
  const hasNonOrigin = points.some((point) => point.latitude !== 0 || point.longitude !== 0)
  const usablePoints = hasNonOrigin ? points.filter((point) => point.latitude !== 0 || point.longitude !== 0) : points
  if (usablePoints.length < 2) return undefined
  const timeDeltas = usablePoints.slice(1).map((point, index) => point.timestamp - usablePoints[index].timestamp).filter((delta) => delta > 0 && Number.isFinite(delta))
  const gapLimit = Math.max(10_000, median(timeDeltas) * 20)
  const segments: FlightTrackPoint[][] = [[usablePoints[0]]]
  let distanceMeters = 0
  for (let index = 1; index < usablePoints.length; index += 1) {
    const previous = usablePoints[index - 1]
    const point = usablePoints[index]
    if (point.timestamp - previous.timestamp > gapLimit) segments.push([point])
    else {
      segments[segments.length - 1].push(point)
      distanceMeters += haversineMeters(previous, point)
    }
  }
  const altitudeValues = usablePoints.flatMap((point) => point.altitude === undefined ? [] : [point.altitude])
  return {
    channels,
    segments: segments.filter((segment) => segment.length >= 2),
    pointCount: usablePoints.length,
    coordinateCoverage: usablePoints.length / Math.max(1, parsed.timestamps.length),
    distanceMeters,
    minLatitude: Math.min(...usablePoints.map((point) => point.latitude)),
    maxLatitude: Math.max(...usablePoints.map((point) => point.latitude)),
    minLongitude: Math.min(...usablePoints.map((point) => point.longitude)),
    maxLongitude: Math.max(...usablePoints.map((point) => point.longitude)),
    minAltitude: altitudeValues.length ? Math.min(...altitudeValues) : undefined,
    maxAltitude: altitudeValues.length ? Math.max(...altitudeValues) : undefined
  }
}

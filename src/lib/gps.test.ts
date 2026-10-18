import { describe, expect, it } from 'vitest'
import type { ChannelDefinition, ParsedLog } from '../types'
import { buildFlightTrack, combinedGpsChannels, detectGpsChannels, parseGpsCell } from './gps'

function channel(key: string, label: string, unit = 'deg', index = 0): ChannelDefinition {
  return { key, rawLabel: label, label, unit, occurrence: 1, index, kind: 'numeric' }
}

function parsed(channels: ChannelDefinition[], series: ParsedLog['series']): ParsedLog {
  const timestamps = [0, 1000, 2000]
  return {
    hash: 'gps-test', fileName: 'gps.csv', delimiter: ',', rowCount: timestamps.length,
    startLocal: '2026-01-01T00:00:00', endLocal: '2026-01-01T00:00:02', startMs: 0, endMs: 2000,
    timestamps, channels, series, summaries: [], warnings: [], schemaFingerprint: 'gps-test'
  }
}

describe('GPS telemetry', () => {
  it('splits FrSky GPS cells into numeric coordinates for mapping', () => {
    const channels = combinedGpsChannels([channel('gps', 'GPS', '', 32), channel('alt', 'GPS alt', 'm', 33)])
    const cells = ['43.6739000 -79.8920000', '', '43.6753000 -79.8906000'].map(parseGpsCell)
    const log = parsed(channels, Object.fromEntries(channels.map((channel, index) => [channel.key, cells.map((cell) => cell?.[index] ?? null)])))
    const track = buildFlightTrack(log)
    expect(track?.pointCount).toBe(2)
    expect(track?.minLatitude).toBe(43.6739)
    expect(track?.minLongitude).toBe(-79.892)
    expect(track?.distanceMeters).toBeGreaterThan(100)
    expect(channels.map((channel) => channel.index)).toEqual([32, 32])
  })

  it('rejects malformed and out-of-range combined GPS cells', () => {
    for (const raw of ['', '43.6', '43.6 -79.8 extra', '91 -79', '43 -181', 'NaN -79']) {
      expect(parseGpsCell(raw)).toBeUndefined()
    }
    expect(parseGpsCell('  -43.6   +79.8  ')).toEqual([-43.6, 79.8])
    expect(parseGpsCell('0 0')).toEqual([0, 0])
  })

  it('detects common DJI-style coordinates and colors the track from altitude data', () => {
    const log = parsed([
      channel('lat', 'Latitude', 'deg', 0),
      channel('lon', 'Longitude', 'deg', 1),
      channel('alt', 'Altitude', 'm', 2)
    ], {
      lat: [43.6000, 43.6005, 43.6010],
      lon: [-79.6000, -79.5995, -79.5990],
      alt: [4, 28, 51]
    })
    expect(detectGpsChannels(log)).toEqual({ latitudeKey: 'lat', longitudeKey: 'lon', altitudeKey: 'alt', altitudeUnit: 'm' })
    const track = buildFlightTrack(log)
    expect(track?.pointCount).toBe(3)
    expect(track?.minAltitude).toBe(4)
    expect(track?.maxAltitude).toBe(51)
    expect(track?.distanceMeters).toBeGreaterThan(100)
  })

  it('accepts flexible GPS labels and prefers aircraft position over home coordinates', () => {
    const log = parsed([
      channel('homeLat', 'Home Latitude', 'deg', 0),
      channel('homeLon', 'Home Longitude', 'deg', 1),
      channel('lat', 'GPS.lat', 'deg', 2),
      channel('lon', 'Position Lng', 'deg', 3),
      channel('alt', 'Relative Height', 'ft', 4)
    ], {
      homeLat: [43.5, 43.5, 43.5], homeLon: [-79.5, -79.5, -79.5],
      lat: [43.6, 43.601, 43.602], lon: [-79.6, -79.601, -79.602], alt: [10, 20, 30]
    })
    expect(detectGpsChannels(log)).toMatchObject({ latitudeKey: 'lat', longitudeKey: 'lon', altitudeKey: 'alt', altitudeUnit: 'ft' })
  })

  it('converts radian coordinates, ignores zero placeholders, and rejects invalid pairs', () => {
    const radians = parsed([channel('lat', 'Aircraft Latitude', 'rad', 0), channel('lon', 'Aircraft Longitude', 'rad', 1)], {
      lat: [0, 43.6 * Math.PI / 180, 43.601 * Math.PI / 180],
      lon: [0, -79.6 * Math.PI / 180, -79.601 * Math.PI / 180]
    })
    const track = buildFlightTrack(radians)
    expect(track?.pointCount).toBe(2)
    expect(track?.minLatitude).toBeCloseTo(43.6)

    const invalid = parsed([channel('lat', 'Latitude'), channel('lon', 'Longitude')], { lat: [999, 999, 999], lon: [999, 999, 999] })
    expect(detectGpsChannels(invalid)).toBeUndefined()
    expect(buildFlightTrack(invalid)).toBeUndefined()
  })
})

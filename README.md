# FlightTrace — FrSky Telemetry Analyzer

FlightTrace is a local-first static web application for importing, organizing,
charting, and diagnosing FrSky and generic telemetry CSV logs. The hosting
server delivers only the application shell. CSV contents and derived results
remain in the user's browser.

The CSV parser is embedded in the application bundle and runs in a local worker,
so importing a file does not fetch a separate parser script that could disappear
after a deployment. If an older open tab reports a parser or network error,
reload the application to get the current version; reloading preserves the local
library. Offline-cache registration failures do not prevent local imports.

## Telemetry queries

The log data explorer filters samples with readable expressions such as
`` `RSSI (dB)` < 45 and `Rx Batt (V)` < 4.8 ``. The editor autocompletes channel
names and syntax while typing, wrapping channel names in backticks automatically. Queries support
`and`, `or`, `not`, parentheses, arithmetic, elapsed `time` in seconds, and the
`between()`, `present()`, `missing()`, and `abs()` functions. Matching samples
can be viewed as a trace and table or exported as normalized CSV.

## Display units

Global unit preferences can convert altitude, distance, speed, vertical speed,
temperature, and pressure across charts, statistics, maps, telemetry queries,
and normalized CSV exports. Conversion is display-only: imported telemetry,
diagnostic thresholds, and raw JSON reports retain their recorded values.

## Flight insights

Each log includes an incident review, historical comparisons, and RF redundancy
analysis. Reviewing an episode selects its relevant channels and opens a chart
window with ten seconds of context on each side. **Show full recording** restores
the model's chart selection. JSON reports include the insights in recorded units;
historical results carry a loading, ready, insufficient-data, or error status.

- Incident review groups nearby diagnostic alerts within the same flight segment
  and describes their recorded order. Proximity does not establish a shared cause.
  Diagnostic hysteresis prevents threshold chatter, and missing samples or long
  logging gaps reset alert continuity.
- Historical analysis compares time-weighted medians in the current log's most
  observed throttle or RPM band with up to 12 earlier logs for the same model.
  It uses included segments and identical channel keys and units. Each signal
  requires at least three distinct earlier logs, ten valid intervals and ten
  seconds per log in the band, and 80% coverage. The comparison range is the
  historical median ± the larger of three scaled median absolute deviations
  (3 × 1.4826 × MAD) and a signal-specific minimum change allowance. It is a
  screening heuristic, not a prediction interval. Flight phase, weather, pack
  identity, and equipment changes are not controlled for.
- RF analysis reports per-channel low durations and simultaneous low episodes
  for independently identified links using the same metric. Model channel display
  names can identify receivers (`RX1 VFR`, `RX2 VFR`) or bands (`VFR 2.4G`,
  `VFR 900M`). Only use these names for separately recorded links. Duplicate or
  ambiguous names are not paired. Thresholds use the highest enabled low-value
  rule; VFR defaults to 50% if no rule exists, and RSSI requires a configured rule.
  Values exactly at the threshold are excluded from low-duration measurements.

Duration measurements omit missing observations, reversed or duplicate time,
and intervals longer than four median sample periods (with a one-second minimum).
Logs without sensor freshness flags cannot establish whether repeated values are
fresh. Comparisons run locally, parse prior logs one at a time, and stop when the
log view is closed. No historical data is uploaded.

## Development

Requires Node.js 22 or newer.

```sh
npm ci
npm run dev
npm run lint
npm test
npm run build
```

Run browser tests after installing the Playwright browsers:

```sh
npx playwright install
npm run test:e2e
```

Continuous integration additionally installs Microsoft Edge and runs the same
upload and analysis checks in Edge, Chromium, Firefox, and mobile WebKit.

The checked-in tests use generated telemetry data. CSV files are ignored and
real flight logs must remain outside this repository.

## Local data and privacy

- Raw logs, model profiles, summaries, rules, events, and edited flight
  segments are stored in IndexedDB for the current browser origin.
- The application has no accounts, remote fonts, telemetry API, upload endpoint,
  analytics, or site-usage tracking.
- Users can request persistent browser storage and export a complete ZIP backup.
- Moving to a different domain creates a new browser origin. Export a backup on
  the old domain and restore it on the new one.

The host can still record normal requests for the static application files and
the visitor's IP address. It never receives the selected CSV through the app.

## Static deployment

The Vite build uses relative assets and hash routes, so `dist/` can be deployed
at a domain root or repository subpath.

### Cloudflare Pages

- Root directory: the repository root
- Build command: `npm ci && npm run build`
- Output directory: `dist`
- Node version: 22

The generated `_headers` file supplies the production security policy.

### GitHub Pages

The included workflow tests the app and deploys `dist/` after every push to
`main`. In the repository's **Settings → Pages**, select **GitHub Actions** as
the source. The default site URL is:

<https://bt-flyer.github.io/FlightTrace/>

GitHub Pages does not consume Cloudflare's `_headers` file, so equivalent
security headers require a fronting CDN or custom hosting configuration.

## Backup format

A backup is a ZIP archive with a versioned `manifest.json`, model/log metadata,
flight segments, diagnostic events, global settings, and raw CSVs under `logs/`. Log IDs are
SHA-256 content hashes and are used for duplicate detection during restore.

## License and warranty

Copyright © 2026 FlightTrace contributors.

FlightTrace is free software licensed under the [GNU General Public License
version 3](LICENSE) only (`GPL-3.0-only`). You may redistribute and modify it
under those terms, which require covered redistributed versions to remain
available under the GPL with corresponding source code.

FlightTrace and its telemetry analysis are provided **as is**, without warranty
of any kind, to the extent permitted by applicable law. Analysis is advisory;
always follow the guidance supplied by the aircraft, radio, receiver, battery,
engine, and telemetry-equipment manufacturers. See sections 15 and 16 of the
license for the complete warranty disclaimer and limitation of liability.

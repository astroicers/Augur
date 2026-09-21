# Mascot — a Grafana panel that reads your alerts out loud

Puts a small 2D sprite mascot on your dashboard. It watches the cursor, reacts when
you click, changes expression with alert severity, and speaks the panel's alert state
using the browser's built-in Web Speech API.

No backend, no external service, no API key. Everything runs in the browser tab that
has the dashboard open.

## Requirements

- Grafana **13.2.x** is what this is developed and tested against. The plugin declares
  `>=12.3.0`, which is the scaffold's default and **has not been verified** on anything
  below 13.x — treat older versions as untested rather than supported.
- A browser with the Web Speech API (Chrome and Edge are the tested ones).
- For Chinese speech: a Chinese voice installed **in your operating system**. The
  browser does not ship voices of its own — it exposes whatever the OS provides. The
  panel detects available voices at runtime and falls back gracefully when none match.

## Status

Working, but **the mascot does not look like a mascot yet**.

Implemented and in use:

- **Alert source.** Reads the panel's own alert state and pulls per-rule detail
  (severity, summary, current value) from Grafana's rules endpoint.
- **Speech.** Web Speech API, with a queue that plays one message at a time and never
  talks over itself. Voice selection prefers a local Chinese voice and degrades when
  none is installed.
- **Flood control.** A firing alert is spoken once, not once per refresh. Recovery is
  spoken only for alerts that were actually announced.
- **Cursor tracking and click detection** across the whole dashboard, with automatic
  fallback to this panel alone when the surrounding DOM is not reachable.

Not implemented:

- **The sprite artwork.** The panel currently renders a `DiagnosticAvatar` — a plain
  3×3 grid of dots that shows which direction the character *would* be looking. It is
  deliberately abstract, not a placeholder character, so that nobody mistakes it for
  the finished design. The rendering contract it implements is the same one the sprite
  version will use, so swapping it in changes no wiring.

Install it if you want the speech and the alert reactions today, and do not mind that
the character is a grid of dots.

## Installing

This plugin is **not signed**. Grafana refuses to load unsigned plugins unless you say
otherwise, so you need two things: the built files in the right place, and an allowlist
entry.

Point the plugin directory at the **build output**, not at a source checkout — Grafana
scans for directories containing a `plugin.json`, and in a source tree that file lives
under `src/`, where Grafana will not find it.

```bash
npm install
npm run build
# then either copy the build output...
cp -r dist/* /var/lib/grafana/plugins/augur-mascot-panel/
# ...or symlink it, which is nicer while developing
ln -s "$PWD/dist" /var/lib/grafana/plugins/augur-mascot-panel
```

Then allow it in `grafana.ini`:

```ini
[plugins]
allow_loading_unsigned_plugins = augur-mascot-panel
```

and restart Grafana.

> If the plugin directory contains a stale `MANIFEST.txt` left over from an earlier
> signed build, Grafana will refuse to load it regardless of the allowlist — modified
> signatures are never loaded. Delete the file and rebuild.

Grafana Cloud does not accept unsigned plugins, so this install path is for
self-hosted Grafana only.

## Known limitations

**It is not compatible with the Plugin Frontend Sandbox.** Two of its features — the
full-dashboard cursor tracking and detecting which panel you clicked — reach outside
the panel's own DOM, which is exactly what the sandbox is designed to prevent. The
sandbox is off by default. If your Grafana has it enabled for this plugin, the mascot
degrades to tracking only within its own panel rather than breaking outright.

Those same two features rely on Grafana DOM attributes that carry no compatibility
guarantee. They are expected to need attention across Grafana upgrades, and they fail
soft by design.

The panel reads **its own** query results and alert state. Grafana gives a panel no
supported way to read another panel's data. To react to a different panel's numbers,
point this panel's query at the built-in `-- Dashboard --` data source and select the
source panel.

## Before it can say anything

The panel gets alert state from Grafana itself, and Grafana only hands it over when
**four** things are all true. Miss any one of them and the panel loads, renders, and
stays silent forever — with no error anywhere. This is the single most common reason
for "it does nothing".

1. The panel has **at least one query**. An empty panel receives no alert state.
2. The alert rule carries the `__dashboardUid__` and `__panelId__` **annotations**
   pointing at this dashboard and this panel. Rules created from the panel's own
   *Alert* tab get these automatically; rules written by hand or provisioned from a
   file usually do not.
3. The dashboard's time range **ends at `now`**. A range ending in the past receives no
   alert state.
4. The plugin itself declares alert-state support — it does, you do not need to do
   anything for this one.

The panel shows the raw value it is receiving in a small `alertState:` chip in its
header, so you can tell the difference between "no alerts" and "never wired up". A
dash (`—`) means Grafana is not sending any alert state at all, which points at one of
the first three items above.

## Configuration

Thresholds use Grafana's standard field-config thresholds, so they are edited in the
usual place in the panel editor and can be overridden per field.

The panel's own options:

| Option | Default | What it does |
|---|---|---|
| Minimum severity | all | Only speak alerts at or above this severity. Recovery messages ignore this — if it announced the problem, it announces the recovery. |
| Repeat interval | 0 (never) | How often to re-announce an alert that is still firing. |
| Fallback severity | `critical` | Severity to assume when the rules endpoint cannot be reached. That endpoint carries no stability guarantee, so failing to reach it is an expected outcome rather than an error. |
| Language | Chinese | Language of the spoken text. |
| Enable speech | on | Turn off to keep the visual reactions without any sound. |
| Voice | auto | Name a specific system voice. Left empty, it prefers a local Chinese voice. |

There are no options for sprite sheets or size. Size follows the panel; the artwork is
not configurable.

Browsers may require a user gesture before they will speak. The panel shows an
**Enable speech** button when it has room for one; clicking it once per tab is enough.

## License

Apache-2.0.

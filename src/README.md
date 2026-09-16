# Mascot — a Grafana panel that reads your alerts out loud

Puts a small 2D sprite mascot on your dashboard. It watches the cursor, reacts when
you click, changes expression with alert severity, and speaks the panel's alert state
using the browser's built-in Web Speech API.

No backend, no external service, no API key. Everything runs in the browser tab that
has the dashboard open.

## Requirements

- Grafana **12.3.0** or later.
- A browser with the Web Speech API (Chrome and Edge are the tested ones).
- For Chinese speech: a Chinese voice installed **in your operating system**. The
  browser does not ship voices of its own — it exposes whatever the OS provides. The
  panel detects available voices at runtime and falls back gracefully when none match.

## Status

Early. The mascot, the speech, and the cursor tracking are not implemented yet — this
package currently renders the scaffold's placeholder panel. Install it only if you are
following along with development.

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

## Configuration

Thresholds use Grafana's standard field-config thresholds, so they are edited in the
usual place in the panel editor and can be overridden per field. The panel adds its
own options for sprite sheets, size, and whether speech is enabled.

## License

Apache-2.0.

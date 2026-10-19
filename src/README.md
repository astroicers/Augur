# Mascot — a Grafana panel that reads your alerts out loud

Puts a small 2D sprite mascot on your dashboard. He reacts when you click, changes
expression with alert severity, moves his mouth and blinks while talking, and speaks the
panel's alert state using the browser's built-in Web Speech API. Next to him is a
**record** of what he said, read from Grafana's own alert state history.

No backend, no API key, and nothing to install besides the plugin. Everything runs in the
browser tab that has the dashboard open. An external speech service is optional — see
*External speech service URL* below — and the panel works exactly as before when it is
left empty.

## Requirements

- Grafana **>= 12.3.0**. Developed against 13.2.x; the two browser e2e gates
  (plugin loads; an alert reaches the panel and is spoken by rule name) were run
  on **12.3.0, 12.3.11, 12.4.0, 13.0.1 and 13.2.2** on 2026-10-01. The frontend
  sandbox gate (G-ADR004-4) has only been run on 13.2.2.
  12.3.x needed a fix to get there: its `alertState` object carries a numeric
  `dashboardId` rather than `dashboardUID` (renamed in 12.4.0), so the panel now
  falls back to the public `data.request.dashboardUID`.
  On 2026-10-07 the same checks also passed on **12.4.12**, including after an
  in-place upgrade of an 11.2.2 database.
  The 12.3.0 floor is a real limit, not a scaffold default. On **11.2.2** the plugin
  loads and both e2e gates pass, but Grafana fetches the panel's alert state only
  once, when the page loads. The mascot never hears about an alert that starts or
  ends after that until someone reloads the page. 13.2.2 and 12.4.12 refresh it on
  every dashboard refresh.
- A browser with the Web Speech API (Chrome and Edge are the tested ones).
- For Chinese speech: a Chinese voice installed **in your operating system**. The
  browser does not ship voices of its own — it exposes whatever the OS provides. The
  panel detects available voices at runtime and falls back gracefully when none match.

## Status

Working, and the mascot has its artwork: a tired boy in a blue-whale onesie, final since
2026-10-05. He opens his mouth while speaking, blinks, and his face changes with the alert.

Implemented and in use:

- **Alert source.** Reads the panel's own alert state and pulls per-rule detail
  (severity, summary, current value) from Grafana's rules endpoint.
- **Speech.** Web Speech API, with a queue that plays one message at a time and never
  talks over itself. Voice selection prefers a local Chinese voice and degrades when
  none is installed.
- **Flood control.** A firing alert is spoken once, not once per refresh. Recovery is
  spoken only for alerts that were actually announced. An alert that keeps *flipping*
  between firing and resolved is a different problem, handled by *Flapping suppression*
  below (off by default).
- **Cursor tracking and click detection** across the whole dashboard, with automatic
  fallback to this panel alone when the surrounding DOM is not reachable. Clicking startles
  him; the gaze part is computed but not visible with the current sheets (see below).
- **An optional external voice.** Point *External speech service URL* at an
  OpenAI-compatible speech service and he speaks in that voice instead of the browser's.
  A phrase that fails or times out falls back to the browser voice for the rest of that
  alert, and the panel's voice label says so.
- **A record of what it said.** The list next to the mascot reads Grafana's own alert
  state history for this panel, so it survives a reload and everyone sees the same list.
  Each line is the sentence the mascot speaks. Change the dashboard time range to look
  further back, and use the search box to filter. Lines from the record are never spoken.
  Lines the panel deliberately kept quiet about carry a mark saying so — see *Lines that
  were not read out* below.
- **Exporting that record as CSV**, for pasting into a ticket or a post-mortem. The
  **匯出 CSV** button in the header downloads exactly the lines the list is showing — the
  search box applies — and nothing is uploaded anywhere. See *Exporting the record*
  below for the format.

Not implemented:

- **Eyes that follow the cursor.** The renderer has four stacked layers — gaze,
  expression, mouth, blinking — and the gaze cell is computed from the cursor, but the
  current sheets declare `"features": { "gaze": false }`: his eyes are half closed, which
  leaves too little iris to show a direction at the size the panel renders. Sheets with
  gaze are planned, and a custom pair can supply it today.
- When the panel is too small for the sprite (under 128 px) or a sheet fails to load, it
  falls back to a `DiagnosticAvatar`: a plain 3×3 grid of dots that shows which direction
  the character *would* be looking, and says on the panel why it fell back. That fallback
  is deliberate, not a missing feature.

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

**The record needs Grafana's alert state history in annotations**, which is Grafana's
default (`[unified_alerting.state_history] backend`). With `loki` or `prometheus` the
panel says it cannot read the history and lists only what this tab spoke. With
`multiple`, the record is complete only if annotations is one of the backends. Records
are kept as long as Grafana keeps them (`[unified_alerting.state_history.annotations]
max_age` and `max_annotations_to_keep`, default: forever). Each line uses the
value of the rule's *condition* query, which is what the mascot speaks; if Grafana won't
say which query is the condition, a line leaves the value out rather than show a
different number. The summary in older lines is filled in from the rule's
*current* summary template, so a rule edited since then shows its new wording.

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
| Severity aliases | empty (no aliases) | Map your own severity labels onto the standard ones (`critical`, `error`, `warning`, `info`, `unknown`) so that the threshold above and the expressions can read them: `P1=critical, sev2=warning, disaster=critical`. Case and *surrounding* spaces are ignored (a space inside a label counts, so `sev 1` does not match `sev1`); full-width commas, semicolons and equals signs work too. There are **no built-in aliases** — left empty, nothing is mapped and behaviour is exactly as it was. Malformed entries (no `=`, unknown target, duplicate alias) are skipped and the rest still apply — and **while the panel is open in the panel editor** it shows a line listing exactly which entries were skipped and why, so a typo does not fail silently. That line follows *Language*, and it is **never** shown outside the editor: a wall display is not disturbed by a setting somebody is in the middle of fixing. The panel can only tell it is in the editor from `data.request.app`, which Grafana does not always provide, so the line can also be missing *inside* the editor; that affects the message only — which entries are skipped never depends on it. The spoken sentence keeps the original label (lower-cased, as every severity is), so an alert labelled `P1` is announced as `p1` and not as `critical`. |
| Alert name label | empty (use `alertname`) | Which **instance label** to use as the alert's name — and therefore as the unit of de-duplication, since the panel speaks each name once. Leave it empty and nothing changes: the name comes from `alertname` as before. Set it when a single Grafana rule covers a whole wall of alerts (a query such as `ALERTS{alertstate="firing"}`): Grafana overwrites every instance's `alertname` with the rule's own name, so all of them arrive under one name and only the first one is ever spoken. Keep the original name in a label of its own — `label_replace(…, "wall_alertname", "$1", "alertname", "(.*)")` — and put that label's name here (`wall_alertname`), and each alert under that rule is announced, recovers and repeats on its own. If the label is missing, empty or only whitespace on a given instance, **that instance** falls back to `alertname` (and to the rule name if there is no `alertname` either), so instances with and without the label can sit under the same rule. The **broadcast history** list follows the same option, so an alert keeps one name on both sides; for a history entry the label is read from the `{labels}` part of Grafana's own annotation text, and the rule's name is used if it is not there. The label's value must identify one alert uniquely: alerts that share a value are treated as one (pick `instance`, and two different alerts on the same host are spoken as one). Changing this option takes effect on the panel's next refresh, and only the alerts whose name really changes are announced again, under the new name: the old name counts as superseded, so it is never reported as recovered. Alerts whose name is unchanged — those falling back to `alertname` — carry on silently and are not repeated. Typing `alertname` here is the same as leaving the field empty (surrounding spaces are ignored too), so switching between the two changes nothing at all. |
| Repeat interval | 0 (never) | How often to re-announce an alert that is still firing. |
| Fallback severity | `critical` | Severity to assume when the rules endpoint cannot be reached. That endpoint carries no stability guarantee, so failing to reach it is an expected outcome rather than an error. |
| Language | Chinese | Language of the spoken text. |
| Speak the current value | on | Whether the sentence — spoken *and* in the record — carries the `current value N` part. When the rule's condition is only 0/1, or it queries `ALERTS` (whose value is always 1), that number says nothing and only makes every announcement longer; turn it off there. Turning it off drops **only** that part: the name, severity, affected object, summary and the recovery sentence stay word for word the same. It is not tied to *Enable speech*, because the record keeps showing sentences even with speech off. |
| Enable speech | on | Turn off to keep the visual reactions without any sound. |
| Quiet hours | empty (no schedule) | A `HH:MM-HH:MM` window in which the panel keeps updating but says nothing, such as `22:00-07:00` (across midnight) or `12:00-13:00`. **The start is included, the end is not** — it goes quiet at 22:00 sharp and speaks again at 07:00 sharp. Alerts that arrive during the window are *not* read out afterwards: the display and the record update as usual, the sentences are simply dropped. This is a **dashboard-level** setting shared by every viewer, but it is evaluated against **each viewer's own browser-local time**, so viewers in different time zones go quiet at different absolute moments (and the behaviour on a daylight-saving transition day is whatever the browser's local clock does — an hour that does not exist is never inside the window). It is a different switch from the per-browser voice button below; when both apply, **either one is enough to stay silent**. Left empty — or set to something malformed (no `-`, an impossible time, identical endpoints) — nothing is scheduled and behaviour is exactly as it was. Full-width colons and hyphens are accepted. |
| Still speak critical in quiet hours | off | While inside the quiet-hours window, let a **firing** `critical` alert through anyway; everything else stays silent. The severity is read through *Severity aliases* first, so it is the same resolved value the minimum-severity threshold uses. **A `critical` that broke the silence is also announced when it recovers**: once you have been woken up, you get to hear how it ended instead of having to walk over to a screen. The converse holds, and it is the part people get wrong — an alert that was *not* spoken through the silence (anything below `critical`, or anything at all while this switch is off) still recovers in silence, so this is not "every `critical` recovery is spoken". Only the same window counts: something announced last night that recovers tonight is not spoken, and a browser that was on mute never made a sound, so it has no recovery to deliver either. This applies to the scheduled window only: it never overrides the per-browser voice button. |
| Flapping suppression: flip threshold | 0 (off) | How many times the same alert may flip between firing and resolved inside the window below before the panel stops reading it out. For example with a threshold of 4 and a window of 10 minutes: **it goes quiet after 4 flips in 10 minutes and speaks again once the alert has held one state for 10 minutes** — and what it says then is the *current* state, so if the alert quietly recovered while it was being suppressed you still hear the recovery, and if it is still burning you hear that instead. The flip that reaches the threshold is still spoken; the ones after it are not. While suppressed the display, the expression and the record keep updating as usual — only the sentences are dropped. Alerts held back by *Minimum severity* are not counted as flips, for the same reason they are not deduplicated: something that should never have been spoken must not silence something else. `0` or empty means nothing is suppressed and behaviour is exactly as it was. |
| Flapping suppression: window (minutes) | 10 | The window the flips are counted in, and also how long one state must hold before suppression is lifted. Anything that is not a number greater than zero (including `0`) turns the whole feature off: a window of zero would make "held one state for a full window" true immediately, which is not a setting anybody wants. |
| Voice | auto | Name a specific system voice — part of the name is enough, such as `Zhiwei`. Left empty, it prefers a local Chinese voice. The panel shows which voice it ended up using. |
| Pitch | 1 | Speaking pitch, 0–2. To make him sound like a little boy, pick a male voice and raise this to about 1.4–1.7. Some browsers (reportedly Edge) ignore it. |
| Rate | 1 | Speaking rate, 0.5–2. It is sent to an external speech service too, but the reference service ignores it — its rate comes from its voice sample. |
| External speech service URL | empty (browser voices) | An OpenAI-compatible `/v1/audio/speech` service to speak with instead of the browser's voices. Empty means nothing changes. **There is no field for an API key**: panel options are stored in the dashboard, so anyone who can see the dashboard can read them. With an external voice the mouth follows the loudness of the audio rather than a fixed rhythm. *Voice* and *Pitch* then apply only to the fallback. |
| External speech timeout | 30 s | How long to wait for one phrase's audio, counted from when that phrase is due to be spoken (time it spent queued on the service during prefetch does not count). On timeout the browser voice reads the rest of that alert. The next alert tries the service again. |
| Directions sprite URL | empty (built-in) | A 3×3 sheet of gaze directions. Must be square with a side divisible by 3. |
| Reactions sprite URL | empty (built-in) | A 3×3 sheet of expression, mouth and blink overlays. Must be the same size as the directions sheet. |

There is no size option: size follows the panel. The two sprite URLs accept any URL,
but only the built-in sheets are checked for alignment — with a custom sheet the panel
shows **自訂圖，對齊未驗證** ("custom sheet, alignment not verified"). If the reactions sheet
fails to load or does not match, the character keeps tracking the cursor without
expressions; if the directions sheet fails, the panel falls back to the dot grid.

The header has a **voice button** that belongs to the person watching, not to the
dashboard. It is shown when the panel has room for it (at least 320×180 px):

- **🔊 語音開** (voice on) / **🔇 靜音中** (muted): click to mute or unmute *this
  browser*. It is remembered across reloads (stored locally) and applies to every
  mascot panel in that browser, including other panels on the same page right away.
  Alerts that fire while muted are not spoken later when you unmute. While muted the mascot still changes expression and the
  record still updates; it just does not speak. A wall display can stay on while a
  person at their desk stays quiet.
  This button and the *Quiet hours* option above are two different switches — one
  belongs to the person watching, the other to the dashboard — and either one being
  active is enough to stay silent.
- **🔊 點一下啟用語音** (click to enable voice): browsers refuse to speak until someone
  has interacted with the page. If an alert was already firing when the page opened,
  its sentence was refused. The button says so, and clicking it speaks the refused
  sentences instead of muting — only those from the last 10 minutes, and only the latest
  state of each alert (if it already recovered, you hear the recovery). The same label
  appears when an external speech service (ADR-005) was blocked by the browser's autoplay
  policy; clicking wakes it up.

The panel option *Enable speech* still turns speech off for everyone viewing the
dashboard; when it is off the voice button is hidden.

## Lines that were not read out

A line can be on the list and still never have been spoken: *Quiet hours* and *Flapping
suppression* both keep the display, the expression and the record updating while dropping
the sentence. Those lines carry a mark so the reason is visible instead of being guessed:

| Mark | Why | Set by |
|---|---|---|
| **抖動中，未念** / *flapping, not spoken* | The alert flipped between firing and resolved too many times inside the window, so flapping suppression held it back. Suppression lifts once it holds one state for a full window: the current state is read out then only if it differs from the state announced last; if they match, nothing is said. | *Flapping suppression: flip threshold* / *window* |
| **靜音時段，未念** / *quiet hours, not spoken* | The quiet-hours window is on right now and this alert does not break the silence. It is not read out later when the window ends. | *Quiet hours* / *Still speak critical in quiet hours* |

The wording follows *Language*, and the mark is also exposed as a `data-suppressed`
attribute on the line whose **value is the reason itself** (`flapping` or `quiet`), so
automation does not have to match on display text. Lines without a mark are rendered
exactly as before.

Three honest limits:

- **Only decisions this browser tab made can be marked.** It is the same `session` /
  `history` split as the `data-origin` attribute and the CSV's `來源` column: a line read
  back from Grafana's alert state history records that the *state changed*, not whether
  this tab said anything about it. When the same event is in both, the list keeps the
  history line — and the mark moves onto it, because "this tab did not speak this" is true
  of the event no matter which of the two lines is the one being shown. A history line with
  no session line to match (anything that happened before you opened the tab, which is most
  of the record) is never marked: the suppression was this tab's decision in the moment,
  the record does not have it, and it is not guessed. Matching is unchanged — same sentence
  and within the same ten-minute merge window as before.
- **The per-browser voice button is not a reason.** Muting your own browser silences
  everything on this machine and nothing is marked for it — the button itself already says
  so, and the mark is reserved for decisions the panel made that you cannot otherwise see.
- The marks are **not** in the CSV export: its three columns are unchanged.

## Exporting the record

The header also has an **匯出 CSV** ("export CSV") button. It downloads **the lines the
list is showing right now** — the search box applies, so filter first and you export only
the matching lines. The file is built inside the browser tab (no backend, nothing is
uploaded, no request leaves the page) and the button is shown at the same size threshold
as the voice button (at least 320×180 px).

The file has a header row and three columns:

| Column | Contents |
|---|---|
| `時間（ISO 8601，UTC）` | When the state change happened — for lines this tab spoke, when it spoke them. Always **UTC with a trailing `Z`** (`2026-10-18T09:00:00.000Z`), never a local offset, so a hand-over across time zones cannot read the column as someone else's clock. The list on screen keeps showing your own local time. |
| `來源` | `紀錄` for a line read from Grafana's alert state history, `本分頁` for one this browser tab spoke but the history does not have (an alert that was already burning before the time range started). Same split as the `data-origin` attribute on each line. |
| `句子` | The sentence, word for word what the mascot says. |

Format details, all of them deliberate:

- **RFC 4180 quoting.** A field containing a comma, a double quote, a line break, or
  leading/trailing whitespace is wrapped in double quotes, and any double quote inside it
  is doubled. Round-tripping is covered by tests.
- **Formula injection is blocked by a leading apostrophe.** Spreadsheets evaluate a cell
  that starts with `=`, `+`, `-` or `@` as a formula (which is how a CSV turns into an
  external-link or DDE prompt), and alert text starting with `-` is ordinary — Grafana's
  own history strings end in `- A=0.93`. Such a cell is exported with a single quote in
  front of it (the OWASP recommendation), and so is a cell starting with a tab or a CR, or
  with whitespace before the `=`. **That apostrophe is part of the cell**: a sentence
  beginning with `=` reads `'=…` when you paste it back into a ticket. That is the trade:
  a visible character instead of a cell that a spreadsheet might run.
- **A UTF-8 BOM** is written first, because Excel on Windows reads a BOM-less CSV in the
  system's legacy encoding and turns every Chinese sentence into mojibake.
- **Records are separated by CRLF** (RFC 4180), including after the last one.
- **The file name** is `augur-broadcast-<dashboard uid>-panel<panel id>-<UTC stamp>.csv`,
  for example `augur-broadcast-dash-1-panel7-20261018T090000Z.csv`. Only
  `A-Za-z0-9_-` survive in it: anything else in the dashboard uid becomes `-`. The uid
  segment is **left out entirely** when Grafana does not give the panel one (12.3.x alert
  state carries a numeric `dashboardId`, and an unsaved dashboard has no uid at all) — the
  name never contains `undefined`.
- **When the list is empty the button is disabled**, so there is no such thing as an
  exported file with a header row and nothing under it.

## License

Apache-2.0.

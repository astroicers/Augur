# Changelog

## 0.4.0 — 2026-10-19

No new options. Panels configured for 0.3.0 keep working as they are; the changes below are
in what the mascot shows and says.

### Take the record with you

- New button **匯出 CSV** next to the voice switch. It downloads the rows currently in the list,
  after the filter is applied, as a CSV with three columns: time (ISO 8601, UTC), source
  (record or this tab), and the sentence. Commas, quotes and line breaks are escaped. Cells
  starting with `=`, `+`, `-`, `@`, a tab or a carriage return get a leading `'`, so a
  spreadsheet does not run them as formulas. The file name carries the dashboard uid, the
  panel id and the time. The button is greyed out while the list is empty.

### See why something was not spoken

- A row that was held back now says so: **抖動中，未念** (flapping suppression) or
  **靜音時段，未念** (quiet hours). Hover it for the reason. Rows that were spoken look exactly
  as before. When the same event also appears in the record list, the record row carries the
  mark. Events from before this tab was opened carry none: only this tab knows what it held
  back.
- In the panel editor, a line now lists the **嚴重度別名** entries that were skipped and why.
  Before, a typo in that option failed silently. The line shows only while you edit that
  panel, never on a wall screen. A panel with no query at all does not get it.

### Changes

- **靜音時段內仍念 critical**: when a critical alert breaks the quiet hours, its recovery is now
  spoken too, within the same quiet window. In 0.3.0 the recovery stayed silent.
- **告警名稱取自哪個 label**: changing this option now re-speaks only the alerts whose name
  actually changed. Alerts without that label, and switching between empty and `alertname`,
  re-speak nothing. In 0.3.0 every firing alert was spoken again.

### Correction to the 0.3.0 notes

- 0.3.0 said that once a flapping alert stays in one state for a full window, the mascot speaks
  its current state. More precisely: it speaks only if that state differs from the last one it
  announced. If they match, it stays quiet. The hover text on the new mark says this.

### Under the hood

- The list rows, the voice switch, the replay queue for refused sentences, the per-browser mute
  storage and the panel styles each moved out of the panel component into their own module
  with tests. The component went from 1,284 to 1,026 lines. Unit tests went from 632 to 878.
- Files left over from the abandoned AIRI design were removed from the repository: the root
  `.env.example`, `docs/sample-grafana-firing.json`, `avatar/` and `live2d/_archive/`.

## 0.3.0 — 2026-10-16

Every new option below is off or empty by default. Leaving them that way keeps the panel
behaving exactly as in 0.2.1.

### Speak every alert behind one rule

- New option **告警名稱取自哪個 label** (`alertNameLabel`). One Grafana rule can watch a whole
  on-call wall with `ALERTS{alertstate="firing"}`, but Grafana overwrites every instance's
  `alertname` with the rule's name, so the mascot used to speak only the first alert. Keep the
  original name with `label_replace(…, "wall_alertname", "$1", "alertname", "(.*)")` and enter
  `wall_alertname` here. Each alert is then spoken, deduplicated and recorded under its own name.
  Instances without the label fall back to `alertname`.
- New switch **念出目前數值** (`speakValue`, on by default). Turn it off when the value carries no
  meaning, for example a rule on `ALERTS`, whose value is always 1. The spoken sentence and the
  record both drop the "目前數值" part and keep everything else word for word.

### Quieter when it should be

- **值班靜音時段** (`quietHours`, e.g. `22:00-07:00`): during these hours the mascot keeps updating
  but does not speak. With **靜音時段內仍念 critical** turned on, critical alerts are still spoken (not
  their recoveries). Each viewer's own clock decides. The per-browser mute button still works
  on its own.
- **抖動抑制** (`flappingThreshold` / `flappingWindowMin`): an alert that flips between firing
  and resolved too often within the window stops being spoken. Once it has stayed in one state
  for a full window, the mascot speaks its current state.

### Your own severity names

- **嚴重度別名** (`severityAliases`, e.g. `P1=critical, sev2=warning, disaster=critical`) maps the
  severity labels your organisation uses onto the standard levels. Thresholds and expressions
  then work with them instead of treating them as unknown. Malformed entries are skipped.

### Fixes

- No more spoken "undefined" or "[object Object]" when an alert has missing or odd fields. An
  empty or non-text severity no longer throws.
- The mascot no longer gets stuck on "this panel only" when it loaded before the other panels.
  It now switches to following the cursor across the whole dashboard once they appear.

### Under the hood

- The broadcast pipeline now lives in its own React-free module. Sentence splitting has a single
  implementation, pinned by shared golden tests. Unit tests went from 258 to 632.

## 0.2.1 — 2026-10-14

### A voice button you can actually switch

- The **Enable speech** button is replaced by a voice switch for the person watching:
  **🔊 語音開** / **🔇 靜音中**. It mutes only this browser, is remembered after a reload, and
  leaves the expressions and the record running. The old button only woke the speech engine and
  never changed, so it looked like a switch that did nothing.
- If the browser refused to speak because nobody had clicked the page yet (it shows
  `not-allowed`), the button reads **🔊 點一下啟用語音**. Clicking it speaks the sentences that
  were refused. Before, an alert that was already firing when the page opened was never spoken
  in that tab, even after clicking.
- Only sentences refused in the last 10 minutes are replayed, and only the latest state of each
  alert. Muting or unmuting one mascot panel updates the others on the same page right away.
  The same button wakes an external speech service that the browser's autoplay policy blocked.

## 0.2.0 — 2026-10-13

### The mascot keeps a record of what it said (ADR-006)

- The list next to the mascot is now a **record**, not just what this browser tab heard. It reads
  Grafana's own alert state history for this panel, so it survives a page reload, everyone looking at
  the dashboard sees the same list, and alerts that happened while nobody had the dashboard open are
  there too.
- Each line is the same sentence the mascot speaks, including the summary.
- **Look further back** by changing the dashboard's time range. Up to 200 lines are shown; if there are
  more, the panel says so.
- **Search** with the box above the list: rule name, words in the sentence, or a host / pod name.
- Lines loaded from the record are **never spoken**. Only alerts that change while the tab is open are.
- Sentences the mascot spoke in this tab but that fall outside the time range (an alert that started
  before the range) are still listed at the top.
- Needs Grafana's alert state history stored as annotations, which is Grafana's default. If it is
  stored in Loki or Prometheus instead, the panel says so and falls back to listing only what this tab
  spoke. Viewers can read the record; no extra permission is needed. How long records are kept is up to
  Grafana (`[unified_alerting.state_history.annotations] max_age` and `max_annotations_to_keep`,
  default: forever).

## 0.1.0 — 2026-10-08

First release as a Grafana panel plugin, with the final sprite artwork in it (see *The
mascot, final art* below). The version stays at 0.x because of what is still open rather
than what is missing from the panel: the character cannot look at the cursor with these
sheets, the plugin is unsigned and not in Grafana's catalogue, and its logo and
`plugin.json` metadata are still the scaffold's.

This project previously shipped as `airi-ops-bridge`: a push pipeline that took Grafana
webhooks through a Node director and Edge TTS to a 3D VRM avatar on a separate web page.
That page was not the page anyone was looking at. ADR-004 reversed the direction — the
mascot now lives inside the dashboard and pulls its own alert state, with no backend at
all. The old pipeline's code was deleted rather than archived; `git log` still has it.

### Grafana version support, rechecked (2026-10-07)

- Also tested on Grafana 12.4.12, including a Grafana that was upgraded in place from 11.2.2.
  Everything works there.
- Grafana 11.2.2 is confirmed not to work, even though the plugin loads and the automated tests
  pass. On 11.2.2 the panel only learns the alert state when the dashboard is opened. Alerts
  that start or end afterwards are not spoken until the page is reloaded. The minimum stays at
  12.3.0.

### Long alerts on online voices (2026-10-06)

- When the browser's voice is an online one rather than one installed on the computer, long
  alerts are now read in pieces of up to about 10 seconds each. Some browsers have been known
  to cut online voices off after about 15 seconds. Voices installed on the computer still read
  the whole alert in one go.

### A better voice, optional (2026-10-05)

- New panel option *External speech service URL*. Leave it empty and nothing changes: the
  browser's built-in voices read the alerts. Fill it in with an OpenAI-compatible speech
  service and the mascot speaks in that voice instead. The panel asks for one short phrase at
  a time. If the service fails on a phrase, or takes longer than *External speech timeout*
  (30 s by default, counted from when that phrase is due), the built-in voice reads the rest
  of that alert, and the voice label on the panel says so and why. The next alert tries the
  service again.
- With an external voice the mouth follows the loudness of the audio, not a fixed rhythm.
- `tools/tts-server/` is a reference service: a young man's voice speaking standard Mandarin,
  built on Qwen3-TTS (Apache-2.0). It needs an NVIDIA GPU. The voice was generated from a
  text description and is not based on any real person's recording, and it is not pitch-shifted.
  The model and the voice sample are not in this repository.
- The service produces speech more slowly than it is spoken. The first time a given alert is
  read, the mascot starts speaking after 5 to 10 seconds, and it may pause between phrases
  while the rest is still being made. When the same alert fires again, it starts at once,
  because the service remembers the parts of the sentence that repeat.
- The panel's *Rate* setting is sent to the service, but the reference service ignores it;
  its speaking rate comes from its voice sample.
- If the voice model ever cannot stop talking, the service cuts the phrase off and the
  built-in voice reads the rest of that alert instead.
- An earlier version of the reference service (BreezyVoice with a pitch-shifted child voice)
  was replaced before release: in listening tests it sounded like a woman.
- There is no field for an API key. Panel options are stored in the dashboard and anyone
  who can see the dashboard can read them.
- Decision record: ADR-005 (Accepted).

### Voice settings (2026-10-05)

- Two new panel options, *Pitch* and *Rate*, adjust the speaking voice. To make the mascot
  sound like a little boy, pick a male voice and raise the pitch to about 1.4–1.7; some
  browsers (reportedly Edge) ignore pitch.
- *Voice* now accepts part of a voice name, such as `Zhiwei`, instead of the full name.
- The panel shows which voice it is using, and a *Preview* button reads a short sentence with
  the current settings.

### The mascot, final art (2026-10-05)

- The whale-onesie boy now uses the project owner's own artwork (generated with Google Gemini,
  background removed and the mouth and eyes edited from the original pixels). He opens his
  mouth while speaking and blinks, and his face changes with the alert: a sweat drop for
  warnings, an anger mark for critical alerts, a deeper blush when an alert resolves, a
  small sweat drop while an alert is pending, and a sparkle when you click. He does not
  follow the cursor with his eyes; his half-closed eyes leave too little room to show it.
- Provenance, including the original prompt and the fact that it named a third-party
  character as a style reference, is recorded in `docs/asset-provenance.md`.

### The mascot has a face (2026-10-02)

- The panel now renders a sprite mascot instead of the diagnostic dot grid: a sleepy
  chibi anime boy with big honey-coloured eyes and dark circles under them, wearing a
  blue-whale onesie (whale-eyed hood, water spout, a tail curling up behind him). He looks toward the
  cursor (nine gaze cells), changes expression with the alert severity, blinks, moves
  his mouth while speaking, and startles awake when clicked.
- **Update (2026-10-04):** the whale-onesie boy is now the mascot, replacing the original
  character design. The art is still the script-drawn version described below.
- When the cursor rests anywhere on his face he keeps looking at you; gaze is now measured
  from the centre of the face rather than the centre of the panel area, so a cursor on his
  forehead no longer makes him look up.
- This is **placeholder art**, drawn by a script in this repository
  (`tools/sprite-gen/whale-boy.mjs`) to the sprite specification, and it passes every
  mechanical acceptance check. It will be replaced when hand-drawn artwork is delivered.
- Two new panel options, *Directions sheet URL* and *Reactions sheet URL*, let you point
  the panel at your own sheets; the panel marks them as unverified custom art.
- If the sheets fail to load or have the wrong geometry, the panel falls back to the
  diagnostic grid and says why, rather than breaking.

### Fixed since the first cut (2026-09-30)

A full-project adversarial review (three rounds, every finding independently
re-verified) landed as PRs #4's fix batch. The parts a user of the panel would
notice:

- **The panel could go permanently silent.** Changing the fallback-severity
  option while an alert was firing desynchronized the alert source from the
  dedup state; the alert's recovery was swallowed and every later firing of it
  was suppressed forever, with nothing in the UI. Options no longer rebuild
  any pipeline state (the dedup window is updated in place).
- **Changing any TTS option discarded queued announcements** that were already
  marked as spoken — they were simply never heard. Same class of fix.
- **The speech queue could stall forever** if voice loading threw (restricted
  contexts) or an utterance failed to construct; both paths now degrade and
  keep the queue moving, with tests that fail on the pre-fix structure.
- **Voice selection now follows `voiceschanged`** properly: the first non-empty
  voice list is no longer final, and a better match arriving mid-utterance is
  applied between utterances instead of being dropped. Windows/Chrome delivers
  the zh voices late routinely; previously that could mean a whole session on
  the wrong voice.
- **`npm run server` verifies the plugin actually registered** (Grafana only
  scans its plugins directory at process start; `up -d` on a running container
  is a no-op — this combination used to fail silently). CI now brings up the
  full compose stack and runs the browser e2e tests on every push.
- **`npm run package` produces an installable zip** and the README gained an
  install section for people who are not developing the plugin.

The sprite acceptance toolchain (the gate that will judge the artwork when it
arrives) was reworked far more heavily — a fixture that could not draw the
stroke width it claimed, a check that could be self-disabled by the defect it
hunts, and five fixes that no test could fail were all found and closed. The
commit log of PR #4 carries the full account with measurements.

### What it does

- Reads the panel's own alert state and pulls per-rule detail (severity, summary,
  current value) from Grafana's rules endpoint.
- Speaks alerts through the browser's Web Speech API, one message at a time.
- Announces a firing alert once rather than once per refresh, and announces recovery
  only for alerts it actually announced.
- Tracks the cursor and detects clicks across the whole dashboard, falling back to this
  panel alone when the surrounding DOM is not reachable — the fallback is visible in the
  panel header rather than silent.
- Shows the raw `alertState` value it is receiving, so "no alerts" and "never wired up"
  are distinguishable.

### What it does not do yet

- **He cannot look at you.** The artwork that shipped declares no gaze: his eyes are half
  closed, which leaves too little iris to show a direction at the size the panel renders.
  The cursor is still tracked and the gaze cell still computed; nothing on screen shows it.
- **The abstract dot grid is still there as a fallback**, for a panel too small for the
  sprite (under 128 px) or a sheet that fails to load. It shows what the character would
  be doing and says on the panel why it fell back.

### Known limitations

- Not compatible with Grafana's Plugin Frontend Sandbox. Cursor tracking and click
  detection reach outside the panel's own DOM, which is what the sandbox exists to
  prevent. With the sandbox on, those two features degrade rather than break.
- Those features depend on Grafana DOM attributes that carry no compatibility guarantee.
  Expect them to need attention across Grafana upgrades.
- Speech quality is whatever the viewer's operating system provides. This is the price
  of removing the backend; the previous architecture used Edge TTS neural voices.
- Declared minimum Grafana 12.3.0, now actually verified: the browser e2e gates pass
  on 12.3.0, 12.3.11, 12.4.0, 13.0.1 and 13.2.2. Before the 2026-10-01 fix the panel
  *loaded* on 12.3.x but silently degraded — Grafana renamed the internal
  `alertState.dashboardId` to `dashboardUID` in 12.4.0, so on 12.3.x rule details were
  never fetched and every alert was read as a generic "alert" at the fallback severity.

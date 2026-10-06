# Changelog

## 0.1.0 — Unreleased

First release as a Grafana panel plugin. The version stays at 0.x until the sprite
artwork exists — the panel works today, but shipping a mascot panel whose mascot is a
grid of dots as 1.0 would be claiming something it is not.

This project previously shipped as `airi-ops-bridge`: a push pipeline that took Grafana
webhooks through a Node director and Edge TTS to a 3D VRM avatar on a separate web page.
That page was not the page anyone was looking at. ADR-004 reversed the direction — the
mascot now lives inside the dashboard and pulls its own alert state, with no backend at
all. The old pipeline's code was deleted rather than archived; `git log` still has it.

### A real child's voice, optional (2026-10-05)

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

- **The sprite artwork does not exist.** The panel renders a deliberately abstract 3×3
  grid of dots that shows what the character would be doing. The rendering contract is
  the one the sprite version will use, so swapping it in changes no wiring.

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

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

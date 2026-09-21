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
- Developed and tested against Grafana 13.2.x. The declared minimum of 12.3.0 is the
  scaffold's default and has not been verified.

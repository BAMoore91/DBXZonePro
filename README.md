# dbx ZonePro 1260 — RTI XP Series Driver

A two-way RTI XP driver for the dbx ZonePro 1260/1261 (and other ZonePro
series) digital zone processor, controllable over **RS-232** or **TCP/IP**.

Built per the *RTI XP Driver Developer's Guide* (Runtime v25) from the dbx
protocol document *"1-way control of ZonePRO products with RS-232" v1.3*
(both included in this repository, along with the dbx/AMX NetLinx module
specification used as a functional reference).

## Repository layout

| Path | Contents |
|------|----------|
| `driver/` | The RTI driver package sources (XML metadata, JavaScript, help RTF) |
| `tools/verify_protocol.py` | Protocol test-vector validation (checksum + frame builder) |
| `XPDriverGuide_v25.pdf` | RTI XP Driver Developer's Guide |
| `ZonePRORS232Startv1.3.doc` | dbx ZonePro serial/IP protocol guide |
| `dbx_zonepro.doc` | AMX NetLinx module interface spec (functional reference) |

## Building the driver

Package the `driver/` directory into an `.RTIDRIVER` file with RTI's
**PackageDriver** command-line tool (part of the RTI driver SDK):

```
cd driver
PackageDriver -m DriverManifest.xml -o "dbx ZonePro 1260.RTIDRIVER"
```

PackageDriver validates all the XML against RTI's schemas before packaging.
The driver ID GUID in `DriverManifest.xml` was generated for this driver; if
you fork this driver into a different product, generate a new ID with
`PackageDriver -i`.

Minimum versions declared: script runtime **3**, Integration Designer
**9.0** (dynamic naming + conditions), Apex/ID **10.0** for the
autoprogramming metadata (`DeviceDescription.xml`).

## What the driver does

### Transports

* **RS-232** — 57600 baud, 8N1, no handshaking (fixed by the ZonePro).
  The driver:
  * prefixes every command with the Resync-Acknowledge byte (`F0`), frames
    it with `64 00` (Frame Start, Frame Count 0 = unacknowledged/open loop)
    and appends the CCITT-8 checksum;
  * sends the `F0 8C` keep-alive ping every second (via the Comm heartbeat
    API) and drives the **Device Online** variable and
    **Connected/Disconnected** events from the unit's `8C` replies;
  * sends the documented resync sequence (16×`FF` + 261×`F0`) at startup,
    on demand (*Resync Serial Link* function), and automatically when the
    unit floods the line with `FF` resync requests.
* **TCP/IP** — port 3804. Per the dbx protocol appendix, no sync/framing/
  checksum bytes and no ping are used over TCP; messages are sent from the
  Version byte onward. The TCP object auto-reconnects and its connection
  state drives **Device Online**.

### Controls

| Function | dbx message |
|----------|-------------|
| Recall Scene (0–500) | `Recall Scene` (0x9001), scene as UWORD |
| Select Source (zone, input 0–12) | MultiSVSet (0x0100) on the zone's router object, SV `0000`, UBYTE |
| Set Level % / Raw, Level Up/Down | MultiSVSet, router master fader SV `0001`, UWORD 0–415 |
| Mute On/Off/Toggle | MultiSVSet, router master mute SV `0002`, UBYTE 0/1 |
| Set Input Gain % | MultiSVSet on the input gain object, SV `0000`, UWORD |
| Send Custom Command | any message, hex from the Version byte; framing/checksum added automatically |

Per-zone variables: source, level (%, bar-graph friendly), level in dB
(text), mute; plus **Device Online** and **Current Scene**.

**Source-select button feedback.** Because RTI drives a button's active
(on) state from a *boolean* variable, each zone also exposes one boolean
per source — `Zone n Source 1 Selected` … `Zone n Source 12 Selected`
(plus `Zone n No Source Selected` for source 0). Exactly one is true per
zone, keyed by the same source numbers the **Select Source** function
uses. To make a source button highlight when active, bind its active
state to the matching boolean (the button that calls `SelectSource(zone,
3)` binds to `Zone n Source 3 Selected`). The integer `Source` and
`Level` variables don't appear in a boolean/active-state variable picker —
use them for button *text* (with a list format) or a bar graph/slider
instead. Because dbx only
offers third parties an open-loop (one-way) protocol, these variables track
the last commanded values (persisted across processor reboots) rather than
live device feedback — the same approach dbx recommends in the protocol
guide. Scene recalls change device state the driver cannot observe; see the
help text.

### Autoprogramming

`DeviceDescription.xml` declares six "Zone" sources with the
`roomvolumesource` audio capability, so each zone can be dropped into a room
in Integration Designer 10+ and picked as the room's volume device. Per-zone
`Volume Up` / `Volume Down` / `Mute Toggle` functions carry `buttontag` +
`sourceid` attributes (`VolumeUp`, `VolumeDown`, `MuteToggle` on `Zone1` …
`Zone6`). If RTI's standard tag list uses different tag names for these
functions, adjust the `buttontag` attributes in `SystemFunctions.xml` —
PackageDriver warns (but does not fail) on non-standard tags.

## Configuration in Integration Designer

* **Connection** — RS-232 (pick the XP serial port) or TCP/IP (IP address +
  port 3804), and the ZonePro node address (2 hex bytes, factory default
  `00 20`). The driver itself uses node `00 33`, the address dbx documents
  for third-party controllers — don't assign that to the ZonePro.
* **Zones** — enable/disable and name each zone, and set each zone's
  **Router (RTE) object ID** (4 hex bytes). **Object IDs depend on the
  configuration loaded in the unit**, so always verify them against your
  device: read each router's ID with **Ctrl+Shift+O** on the Program
  screen, or capture a command with the **Network Trace** window
  (**Ctrl+Shift+T**). The Ctrl+Shift+O dialog lists the four Address bytes
  as b0–b3 top-to-bottom in **decimal**; the driver wants them in send
  order **b3 b2 b1 b0**, converted to hex (e.g. b0=22, b1=0, b2=5, b3=1 →
  `01 05 00 16`). The shipped defaults were read from a ZonePro 1261
  (Node 32) test unit (`01 05 00 16` … `01 05 05 1B`, zones 1–2 confirmed,
  3–6 following the same Row/Index pattern). **Note:** changing these
  defaults in the driver does *not* update the values already stored in an
  existing Integration Designer project — edit the Zone fields in the
  Driver Configuration Editor to correct an existing install.
* **Level Scaling** (advanced) — raw fader full scale (default 415 = +20 dB),
  0 dB point (default 215), counts-per-dB scale (default 10, per the dbx
  protocol guide: 0 dB = raw 215, +20 dB = raw 415, matching the master
  fader in the ZonePro Designer router editor), up/down step in dB
  (default 1 dB), and the assumed power-on level. If Level Up/Down steps by
  the wrong amount on your unit, adjust **Counts per dB**; if levels top out
  early or late, adjust **Fader Full Scale** (the dbx AMX module used a
  0–221 device range for router output levels on some models).
* **Input Gains** (advanced, optional) — object IDs for the per-input gain
  objects (SV `0000`); leave blank to disable.
* **Debug** (hidden — enable via TraceViewer's *Show Driver Debug Options*) —
  hex-dumps all TX/RX to TraceViewer.

## Protocol validation

The exact byte encoding (CCITT-8 checksum, header layout, MultiSVSet and
Recall Scene builders) is locked against every example string published in
the dbx protocol guide — 11 captured device strings plus the documented
checksum example:

```
python3 tools/verify_protocol.py
```

All 14 checks reproduce the documented frames byte-for-byte, including the
checksum (`BCC = 0x08` for the Section 4 example). The Python builder
mirrors the JavaScript driver logic one-to-one.

## Known limitations

* **Open loop by design.** dbx does not publish the full-duplex protocol to
  third parties (only AMX and Crestron received it), so like the dbx String
  Calculator workflow this driver does not subscribe to device feedback.
  Variables reflect commanded state.
* If the ZonePro configuration is edited in ZonePro Designer, object IDs
  can change — re-check the zone object IDs afterwards.
* Router input numbering follows the dbx convention: stereo input pairs are
  addressed by the lower input number.

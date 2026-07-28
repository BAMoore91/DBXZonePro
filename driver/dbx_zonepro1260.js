//////////////////////////////////////////////////////////////////////////////
//
// dbx ZonePro 1260 - RTI XP Series Two-Way Driver
//
// Controls a dbx ZonePro 1260/1261 (and other ZonePro series) digital zone
// processor via RS-232 (57600 8N1) or TCP/IP (port 3804).
//
// Implementation follows "1-way control of ZonePRO products with RS-232"
// (v1.3, Harman Music Group). This is an open-loop driver as recommended by
// dbx for third-party controllers: commands are sent unacknowledged
// (Frame Count 0x00) and zone state is tracked locally by the driver.
//
// Serial framing:  0xF0 <0x64 0x00 header payload> <CCITT-8 checksum>
//                  plus a 0xF0 0x8C ping every second to hold the link open.
// TCP framing:     header + payload only (no sync/frame/checksum/ping),
//                  per the IP Connections appendix of the dbx protocol guide.
//
//////////////////////////////////////////////////////////////////////////////

// ------------------------------------------------------------------ protocol

// CCITT-8 lookup table from the dbx protocol guide appendix.
var CCITT8 = [
    0x00, 0x5E, 0xBC, 0xE2, 0x61, 0x3F, 0xDD, 0x83, 0xC2, 0x9C, 0x7E, 0x20, 0xA3, 0xFD, 0x1F, 0x41,
    0x9D, 0xC3, 0x21, 0x7F, 0xFC, 0xA2, 0x40, 0x1E, 0x5F, 0x01, 0xE3, 0xBD, 0x3E, 0x60, 0x82, 0xDC,
    0x23, 0x7D, 0x9F, 0xC1, 0x42, 0x1C, 0xFE, 0xA0, 0xE1, 0xBF, 0x5D, 0x03, 0x80, 0xDE, 0x3C, 0x62,
    0xBE, 0xE0, 0x02, 0x5C, 0xDF, 0x81, 0x63, 0x3D, 0x7C, 0x22, 0xC0, 0x9E, 0x1D, 0x43, 0xA1, 0xFF,
    0x46, 0x18, 0xFA, 0xA4, 0x27, 0x79, 0x9B, 0xC5, 0x84, 0xDA, 0x38, 0x66, 0xE5, 0xBB, 0x59, 0x07,
    0xDB, 0x85, 0x67, 0x39, 0xBA, 0xE4, 0x06, 0x58, 0x19, 0x47, 0xA5, 0xFB, 0x78, 0x26, 0xC4, 0x9A,
    0x65, 0x3B, 0xD9, 0x87, 0x04, 0x5A, 0xB8, 0xE6, 0xA7, 0xF9, 0x1B, 0x45, 0xC6, 0x98, 0x7A, 0x24,
    0xF8, 0xA6, 0x44, 0x1A, 0x99, 0xC7, 0x25, 0x7B, 0x3A, 0x64, 0x86, 0xD8, 0x5B, 0x05, 0xE7, 0xB9,
    0x8C, 0xD2, 0x30, 0x6E, 0xED, 0xB3, 0x51, 0x0F, 0x4E, 0x10, 0xF2, 0xAC, 0x2F, 0x71, 0x93, 0xCD,
    0x11, 0x4F, 0xAD, 0xF3, 0x70, 0x2E, 0xCC, 0x92, 0xD3, 0x8D, 0x6F, 0x31, 0xB2, 0xEC, 0x0E, 0x50,
    0xAF, 0xF1, 0x13, 0x4D, 0xCE, 0x90, 0x72, 0x2C, 0x6D, 0x33, 0xD1, 0x8F, 0x0C, 0x52, 0xB0, 0xEE,
    0x32, 0x6C, 0x8E, 0xD0, 0x53, 0x0D, 0xEF, 0xB1, 0xF0, 0xAE, 0x4C, 0x12, 0x91, 0xCF, 0x2D, 0x73,
    0xCA, 0x94, 0x76, 0x28, 0xAB, 0xF5, 0x17, 0x49, 0x08, 0x56, 0xB4, 0xEA, 0x69, 0x37, 0xD5, 0x8B,
    0x57, 0x09, 0xEB, 0xB5, 0x36, 0x68, 0x8A, 0xD4, 0x95, 0xCB, 0x29, 0x77, 0xF4, 0xAA, 0x48, 0x16,
    0xE9, 0xB7, 0x55, 0x0B, 0x88, 0xD6, 0x34, 0x6A, 0x2B, 0x75, 0x97, 0xC9, 0x4A, 0x14, 0xF6, 0xA8,
    0x74, 0x2A, 0xC8, 0x96, 0x15, 0x4B, 0xA9, 0xF7, 0xB6, 0xE8, 0x0A, 0x54, 0xD7, 0x89, 0x6B, 0x35];

var FRAME_START      = 0x64;
var FRAME_COUNT_OPEN = 0x00;    // unacknowledged / open loop
var SYNC_ACK         = 0xF0;
var RESYNC_REQ       = 0xFF;
var PING_BYTE        = 0x8C;

var MSGID_SET          = [0x01, 0x00];   // MultiSVSet 0x0100
var MSGID_RECALL_SCENE = [0x90, 0x01];   // Recall Scene 0x9001

var SRC_DEVICE = [0x00, 0x33];  // dbx-documented node for 3rd-party controllers

// Router object state variables (dbx protocol guide appendix)
var SV_ROUTER_SOURCE = 0x0000;
var SV_ROUTER_FADER  = 0x0001;
var SV_ROUTER_MUTE   = 0x0002;
var SV_INPUT_GAIN    = 0x0000;

var DTYPE_UBYTE = 1;
var DTYPE_UWORD = 3;

var NUM_ZONES  = 6;
var NUM_INPUTS = 12;

// ------------------------------------------------------------------- globals

var g_debug      = false;
var g_useTCP     = false;
var g_comm       = null;
var g_online     = false;
var g_nodeAddr   = [0x00, 0x20];   // ZonePro node address (dest device)
var g_faderMax    = 415;           // raw fader full scale (+20 dB)
var g_fader0dB    = 215;           // raw fader value that equals 0 dB
var g_countsPerDb = 10;            // raw counts per dB (dbx guide: 0 dB=215, +20 dB=415)
var g_levelStep   = 10;            // raw counts per Level Up/Down press (1 dB)
var g_defaultRaw  = 215;

var g_zones  = [];                 // [{enabled, obj, source, raw, mute}]
var g_inputs = [];                 // [{obj, raw}]
var g_scene  = 0;

var g_saveTimer    = new Timer();
var g_resyncTimer  = new Timer();  // running = resync suppressed
var g_ffRun        = 0;            // consecutive 0xFF bytes seen from device

// -------------------------------------------------------------------- debug

// System.Print messages may not contain a percent sign (RTI guide 7.1.2),
// and user-supplied strings can reach these helpers via error paths.
function SafeMsg(msg)
{
    return ("" + msg).replace(/%/g, "<pct>");
}

function DBG(msg)
{
    if (g_debug)
        System.Print("dbx ZonePro: " + SafeMsg(msg) + "\r\n");
}

function ERR(msg)
{
    System.Print("dbx ZonePro ERROR: " + SafeMsg(msg) + "\r\n");
}

function HexDump(bytes)
{
    var s = "";
    for (var i = 0; i < bytes.length; i++) {
        var h = bytes[i].toString(16).toUpperCase();
        if (h.length < 2)
            h = "0" + h;
        s += h + " ";
    }
    return s;
}

// ------------------------------------------------------------------- helpers

function ToInt(v, dflt)
{
    var n = parseInt("" + v, 10);
    if (isNaN(n))
        return dflt;
    return n;
}

function CfgBool(name)
{
    var v = "" + Config.Get(name);
    return (v == "true" || v == "True" || v == "TRUE" || v == "1");
}

function CfgInt(name, dflt)
{
    return ToInt(Config.Get(name), dflt);
}

// Parse a string of hex bytes ("01 05 00 1E", "$01,$05,...", "0105001E")
// into an array of byte values. Returns null on any parse problem.
function ParseHexBytes(str)
{
    if (str == null)
        return null;
    var clean = ("" + str).replace(/0x/gi, " ").replace(/[$,;:\-]/g, " ");
    clean = clean.replace(/^\s+/, "").replace(/\s+$/, "");
    if (clean.length == 0)
        return null;
    var tokens = clean.split(/\s+/);
    var bytes = [];
    for (var i = 0; i < tokens.length; i++) {
        var t = tokens[i];
        if (t.length == 0)
            continue;
        if (t.length % 2 != 0)
            t = "0" + t;
        // parseInt() silently stops at the first bad character ("2G" -> 2),
        // so reject anything that is not pure hex before converting.
        if (!/^[0-9A-Fa-f]+$/.test(t))
            return null;
        for (var j = 0; j < t.length; j += 2)
            bytes.push(parseInt(t.substr(j, 2), 16) & 0xFF);
    }
    if (bytes.length == 0)
        return null;
    return bytes;
}

function BytesToString(bytes)
{
    // Build in chunks; keeps well under any argument-count limits.
    var s = "";
    var CHUNK = 64;
    for (var i = 0; i < bytes.length; i += CHUNK)
        s += String.fromCharCode.apply(null, bytes.slice(i, i + CHUNK));
    return s;
}

function Clamp(v, lo, hi)
{
    if (v < lo) return lo;
    if (v > hi) return hi;
    return v;
}

function PctToRaw(pct)
{
    return Math.round(Clamp(pct, 0, 100) * g_faderMax / 100);
}

function RawToPct(raw)
{
    if (g_faderMax <= 0)
        return 0;
    return Math.round(Clamp(raw, 0, g_faderMax) * 100 / g_faderMax);
}

function RawToDbText(raw)
{
    if (raw <= 0)
        return "Off";
    var db = (raw - g_fader0dB) / g_countsPerDb;
    var txt = db.toFixed(1) + " dB";
    if (db > 0)
        txt = "+" + txt;
    return txt;
}

// ------------------------------------------------------------ frame building

function Checksum(bytes)
{
    var bcc = 0xFF;
    for (var i = 0; i < bytes.length; i++)
        bcc = CCITT8[(bcc ^ bytes[i]) & 0xFF];
    return bcc;
}

// Build a protocol message (Version through end of payload).
// destObj is a 4-byte object address array; the source object mirrors the
// destination object for MultiSVSet, and is 0 for device-level messages,
// exactly as in the dbx-captured examples.
function BuildMessage(srcObj, destObj, msgId, payload)
{
    var len = 21 + payload.length;   // Version..payload, per protocol guide
    var msg = [0x01,
               (len >> 24) & 0xFF, (len >> 16) & 0xFF, (len >> 8) & 0xFF, len & 0xFF,
               SRC_DEVICE[0], SRC_DEVICE[1],
               srcObj[0], srcObj[1], srcObj[2], srcObj[3],
               g_nodeAddr[0], g_nodeAddr[1],
               destObj[0], destObj[1], destObj[2], destObj[3],
               msgId[0], msgId[1],
               0x00, 0x00];          // flags: no ReqAck (open loop)
    return msg.concat(payload);
}

function BuildMultiSVSet(objBytes, svId, dtype, value)
{
    var payload = [0x00, 0x01,                        // one SV in this frame
                   (svId >> 8) & 0xFF, svId & 0xFF,
                   dtype];
    if (dtype == DTYPE_UBYTE) {
        payload.push(value & 0xFF);
    } else {                                          // UWORD
        payload.push((value >> 8) & 0xFF);
        payload.push(value & 0xFF);
    }
    return BuildMessage(objBytes, objBytes, MSGID_SET, payload);
}

function BuildRecallScene(scene)
{
    var zero = [0x00, 0x00, 0x00, 0x00];
    return BuildMessage(zero, zero, MSGID_RECALL_SCENE,
                        [(scene >> 8) & 0xFF, scene & 0xFF]);
}

// Send a message (Version..payload byte array) with transport framing.
function SendMessage(msg)
{
    if (g_comm == null) {
        ERR("communications port not configured, command dropped");
        return;
    }
    var wire;
    if (g_useTCP) {
        wire = msg;                                   // no framing over TCP
    } else {
        var body = [FRAME_START, FRAME_COUNT_OPEN].concat(msg);
        wire = [SYNC_ACK].concat(body);
        wire.push(Checksum(body));                    // BCC over FS,FC,hdr,payload
    }
    DBG("TX: " + HexDump(wire));
    g_comm.Write(BytesToString(wire));
}

// ------------------------------------------------------- serial link keeping

function SendResyncSequence()
{
    if (g_useTCP || g_comm == null)
        return;
    // 16 Resync Requests + 261 Resync Acknowledges, per protocol guide S1.
    var bytes = [];
    var i;
    for (i = 0; i < 16; i++)
        bytes.push(RESYNC_REQ);
    for (i = 0; i < 261; i++)
        bytes.push(SYNC_ACK);
    DBG("sending resync sequence");
    g_comm.Write(BytesToString(bytes));
}

function OnResyncHoldoff()
{
    // Timer expiry only ends the holdoff window; nothing to do.
}

function RequestResync()
{
    if (g_resyncTimer.State != 0)
        return;                                       // rate limited
    SendResyncSequence();
    g_resyncTimer.Start(OnResyncHoldoff, 3000);
}

function OnSendHeartbeat()
{
    if (g_comm != null)
        g_comm.Write(BytesToString([SYNC_ACK, PING_BYTE]));   // F0 8C ping
}

function SetOnline(online)
{
    if (online == g_online)
        return;
    g_online = online;
    SystemVars.Write("Online", online, "BOOLEAN");
    System.SignalEvent(online ? "CONNECTED" : "DISCONNECTED");
    DBG(online ? "device online" : "device offline");
}

function OnHbConnect()
{
    SetOnline(true);
}

function OnHbDisconnect()
{
    SetOnline(false);
}

function OnTCPConnect()
{
    SetOnline(true);
}

function OnTCPDisconnect()
{
    SetOnline(false);
}

// Received data. In open loop the only meaningful serial traffic is the
// 0x8C ping acknowledge and 0xFF resync-request floods.
function OnCommRx(data)
{
    if (g_debug && data.length > 0) {
        var rx = [];
        for (var j = 0; j < data.length && j < 48; j++)
            rx.push(data.charCodeAt(j) & 0xFF);
        DBG("RX(" + data.length + "): " + HexDump(rx));
    }
    if (g_useTCP)
        return;                                       // nothing to track on TCP
    for (var i = 0; i < data.length; i++) {
        var b = data.charCodeAt(i) & 0xFF;
        if (b == RESYNC_REQ) {
            g_ffRun++;
            if (g_ffRun >= 64) {                      // device is resyncing
                g_ffRun = 0;
                RequestResync();
            }
            continue;
        }
        g_ffRun = 0;
        if (b == PING_BYTE)
            g_comm.HeartbeatReceived();
    }
}

// ------------------------------------------------------------- state/sysvars

function UpdateZoneVars(z)
{
    var zone = g_zones[z];
    var n = z + 1;
    SystemVars.Write("Zone" + n + "Source", zone.source);
    SystemVars.Write("Zone" + n + "LevelPct", RawToPct(zone.raw));
    SystemVars.Write("Zone" + n + "LevelDb", RawToDbText(zone.raw));
    SystemVars.Write("Zone" + n + "Mute", zone.mute, "BOOLEAN");
}

function OnSaveTimer()
{
    var parts = [];
    for (var i = 0; i < NUM_ZONES; i++) {
        var zn = g_zones[i];
        parts.push(zn.source + "," + zn.raw + "," + (zn.mute ? 1 : 0));
    }
    Persistence.Write("state_v1", parts.join(";") + "|" + g_scene);
    Persistence.Save();
    DBG("state persisted");
}

function ScheduleSave()
{
    if (g_saveTimer.State == 0)
        g_saveTimer.Start(OnSaveTimer, 3000);
}

function RestoreState()
{
    var data = Persistence.Read("state_v1");
    if (data == null)
        return;
    var halves = ("" + data).split("|");
    var parts = halves[0].split(";");
    for (var i = 0; i < NUM_ZONES && i < parts.length; i++) {
        var f = parts[i].split(",");
        if (f.length < 3)
            continue;
        g_zones[i].source = Clamp(ToInt(f[0], 0), 0, NUM_INPUTS);
        g_zones[i].raw    = Clamp(ToInt(f[1], g_defaultRaw), 0, g_faderMax);
        g_zones[i].mute   = (f[2] == "1");
    }
    if (halves.length > 1)
        g_scene = ToInt(halves[1], 0);
    DBG("state restored from persistence");
}

function OnShutdown()
{
    if (g_saveTimer.State != 0) {
        g_saveTimer.Stop();
        OnSaveTimer();
    }
}

// Returns the zone record, or null (with an error printed) if the zone
// number is invalid, disabled, or has no usable object address.
function GetZone(zoneArg)
{
    var z = ToInt(zoneArg, 0);
    if (z < 1 || z > NUM_ZONES) {
        ERR("invalid zone number '" + zoneArg + "'");
        return null;
    }
    var zone = g_zones[z - 1];
    if (!zone.enabled) {
        ERR("zone " + z + " is disabled in the driver configuration");
        return null;
    }
    if (zone.obj == null) {
        ERR("zone " + z + " has no valid router object ID configured");
        return null;
    }
    return zone;
}

// --------------------------------------------------------- exported functions

function RecallScene(scene)
{
    var s = ToInt(scene, -1);
    if (s < 0 || s > 500) {
        ERR("invalid scene number '" + scene + "'");
        return;
    }
    DBG("recall scene " + s);
    SendMessage(BuildRecallScene(s));
    g_scene = s;
    SystemVars.Write("CurrentScene", s);
    ScheduleSave();
}

function SelectSource(zoneArg, sourceArg)
{
    var zone = GetZone(zoneArg);
    if (zone == null)
        return;
    var src = ToInt(sourceArg, -1);
    if (src < 0 || src > NUM_INPUTS) {
        ERR("invalid source number '" + sourceArg + "'");
        return;
    }
    DBG("zone " + zone.num + " source -> " + src);
    SendMessage(BuildMultiSVSet(zone.obj, SV_ROUTER_SOURCE, DTYPE_UBYTE, src));
    zone.source = src;
    UpdateZoneVars(zone.num - 1);
    ScheduleSave();
}

function SetZoneRaw(zone, raw)
{
    raw = Clamp(raw, 0, g_faderMax);
    DBG("zone " + zone.num + " level -> " + raw + " (" + RawToDbText(raw) + ")");
    SendMessage(BuildMultiSVSet(zone.obj, SV_ROUTER_FADER, DTYPE_UWORD, raw));
    zone.raw = raw;
    UpdateZoneVars(zone.num - 1);
    ScheduleSave();
}

function SetLevelPct(zoneArg, pctArg)
{
    var zone = GetZone(zoneArg);
    if (zone == null)
        return;
    SetZoneRaw(zone, PctToRaw(ToInt(pctArg, 0)));
}

function SetLevelRaw(zoneArg, rawArg)
{
    var zone = GetZone(zoneArg);
    if (zone == null)
        return;
    SetZoneRaw(zone, ToInt(rawArg, g_defaultRaw));
}

function LevelUp(zoneArg)
{
    var zone = GetZone(zoneArg);
    if (zone == null)
        return;
    SetZoneRaw(zone, zone.raw + g_levelStep);
}

function LevelDown(zoneArg)
{
    var zone = GetZone(zoneArg);
    if (zone == null)
        return;
    SetZoneRaw(zone, zone.raw - g_levelStep);
}

function SetZoneMute(zone, mute)
{
    DBG("zone " + zone.num + " mute -> " + mute);
    SendMessage(BuildMultiSVSet(zone.obj, SV_ROUTER_MUTE, DTYPE_UBYTE, mute ? 1 : 0));
    zone.mute = mute;
    UpdateZoneVars(zone.num - 1);
    ScheduleSave();
}

function MuteOn(zoneArg)
{
    var zone = GetZone(zoneArg);
    if (zone == null)
        return;
    SetZoneMute(zone, true);
}

function MuteOff(zoneArg)
{
    var zone = GetZone(zoneArg);
    if (zone == null)
        return;
    SetZoneMute(zone, false);
}

function MuteToggle(zoneArg)
{
    var zone = GetZone(zoneArg);
    if (zone == null)
        return;
    SetZoneMute(zone, !zone.mute);
}

function SetInputGainPct(inputArg, pctArg)
{
    var i = ToInt(inputArg, 0);
    if (i < 1 || i > NUM_INPUTS) {
        ERR("invalid input number '" + inputArg + "'");
        return;
    }
    var input = g_inputs[i - 1];
    if (input.obj == null) {
        ERR("input " + i + " has no gain object ID configured");
        return;
    }
    var raw = PctToRaw(ToInt(pctArg, 0));
    DBG("input " + i + " gain -> " + raw);
    SendMessage(BuildMultiSVSet(input.obj, SV_INPUT_GAIN, DTYPE_UWORD, raw));
    input.raw = raw;
}

// Passthrough for anything the driver does not expose directly. The string
// is the message from the Version byte (0x01) through the end of the
// payload, in hex ("01 00 00 00 1B 00 33 ..."). The driver adds the serial
// framing (F0 64 00 ... checksum) or sends it as-is over TCP. Strings can be
// captured from ZonePro Designer's Network Trace window (Ctrl+Shift+T).
function SendCustom(hexArg)
{
    var msg = ParseHexBytes(hexArg);
    if (msg == null) {
        ERR("custom command is not valid hex: '" + hexArg + "'");
        return;
    }
    SendMessage(msg);
}

function ForceResync()
{
    SendResyncSequence();
}

// ------------------------------------------------------------ initialization

function LoadZoneConfig()
{
    for (var i = 0; i < NUM_ZONES; i++) {
        var n = i + 1;
        var zone = {
            num: n,
            enabled: CfgBool("Zone" + n + "Enabled"),
            obj: null,
            source: 0,
            raw: g_defaultRaw,
            mute: false
        };
        if (zone.enabled) {
            var obj = ParseHexBytes(Config.Get("Zone" + n + "ObjectID"));
            if (obj != null && obj.length == 4)
                zone.obj = obj;
            else
                ERR("zone " + n + " router object ID must be 4 hex bytes");
        }
        g_zones.push(zone);
    }
    for (var j = 0; j < NUM_INPUTS; j++) {
        var input = { obj: null, raw: g_defaultRaw };
        var iobj = ParseHexBytes(Config.Get("Input" + (j + 1) + "ObjectID"));
        if (iobj != null && iobj.length == 4)
            input.obj = iobj;
        g_inputs.push(input);
    }
}

function Init()
{
    g_debug = CfgBool("Debug");

    g_useTCP      = (CfgInt("ConnectionType", 0) == 1);
    g_faderMax    = Clamp(CfgInt("FaderMax", 415), 1, 65535);
    g_fader0dB    = Clamp(CfgInt("Fader0dB", 215), 0, g_faderMax);
    g_countsPerDb = Clamp(CfgInt("CountsPerDb", 10), 1, 100);
    // Level Up/Down move by a whole number of dB per press.
    g_levelStep   = Clamp(CfgInt("LevelStepDb", 1), 1, 100) * g_countsPerDb;
    g_defaultRaw  = Clamp(CfgInt("DefaultLevel", 215), 0, g_faderMax);

    var node = ParseHexBytes(Config.Get("NodeAddress"));
    if (node != null && node.length == 2)
        g_nodeAddr = node;
    else
        ERR("ZonePro node address must be 2 hex bytes, using default 00 20");

    LoadZoneConfig();
    RestoreState();

    if (g_useTCP) {
        var host = "" + Config.Get("IPAddress");
        var port = CfgInt("IPPort", 3804);
        if (host.length == 0) {
            ERR("no IP address configured");
        } else {
            g_comm = new TCP(OnCommRx, host, port);
            g_comm.OnConnectFunc = OnTCPConnect;
            g_comm.OnDisconnectFunc = OnTCPDisconnect;
            DBG("TCP transport: " + host + ":" + port);
        }
    } else {
        var port = ToInt(Config.Get("SerialPort"), 0);
        g_comm = new Serial(OnCommRx, port, 57600, 8, 1, "None", "None");
        DBG("serial transport on port handle " + port);
        SendResyncSequence();
        // dbx requires a 0xF0 0x8C ping at 1 second intervals; the ZonePro
        // answers 0x8C, which drives online/offline via HeartbeatReceived().
        g_comm.EnableHeartbeat(1000, OnSendHeartbeat, OnHbConnect, OnHbDisconnect);
    }

    SystemVars.Write("Online", false, "BOOLEAN");
    SystemVars.Write("CurrentScene", g_scene);
    for (var i = 0; i < NUM_ZONES; i++)
        UpdateZoneVars(i);

    System.OnShutdownFunc = OnShutdown;
    DBG("driver initialized (" + (g_useTCP ? "TCP" : "serial") + " mode)");
}

Init();

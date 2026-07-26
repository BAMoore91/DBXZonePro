#!/usr/bin/env node
// Executes the RTI driver script (driver/dbx_zonepro1260.js) against a
// stubbed RTI XP script API and verifies the bytes it writes to the wire
// against frames independently validated by tools/verify_protocol.py.
//
// Usage: node tools/test_driver_js.js

"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

// --------------------------------------------------------------- RTI stubs

let txLog = [];          // strings written to the comm object
let sysvars = {};        // SystemVars.Write log
let events = [];         // System.SignalEvent log
let printed = [];        // System.Print log
let persistStore = {};   // Persistence backing store
let hbState = null;      // heartbeat registration
let serialArgs = null;
let tcpArgs = null;

function makeComm() {
    return {
        Write: function (s) { txLog.push(s); return true; },
        EnableHeartbeat: function (interval, sendFn, connFn, discFn) {
            hbState = { interval, sendFn, connFn, discFn, received: 0 };
            return true;
        },
        HeartbeatReceived: function () {
            if (hbState) hbState.received++;
            return true;
        },
        OnConnectFunc: null,
        OnDisconnectFunc: null,
    };
}

function buildSandbox(config) {
    txLog = []; sysvars = {}; events = []; printed = [];
    hbState = null; serialArgs = null; tcpArgs = null;

    const sandbox = {
        System: {
            Print: (m) => { printed.push(m); return true; },
            SignalEvent: (n) => { events.push(n); return true; },
            OnShutdownFunc: null,
        },
        Config: {
            Get: (name) => (name in config ? config[name] : ""),
        },
        SystemVars: {
            Write: (name, val) => { sysvars[name] = val; return true; },
            Read: (name) => (name in sysvars ? sysvars[name] : null),
        },
        Persistence: {
            Write: (k, v) => { persistStore[k] = v; return true; },
            Read: (k) => (k in persistStore ? persistStore[k] : null),
            Save: () => true,
            Delete: (k) => { delete persistStore[k]; return true; },
        },
        Timer: function () {
            this.State = 0;
            this.Start = (fn, ms) => { this.State = 1; this._fn = fn; return true; };
            this.Stop = () => { this.State = 0; return true; };
            this.Fire = () => { this.State = 0; this._fn(); };
        },
        Serial: function (rx, port, baud, db, sb, par, hs) {
            serialArgs = { rx, port, baud, db, sb, par, hs };
            return makeComm();
        },
        TCP: function (rx, host, port) {
            tcpArgs = { rx, host, port };
            return makeComm();
        },
    };
    sandbox.global = sandbox;
    return sandbox;
}

function runDriver(config) {
    const src = fs.readFileSync(
        path.join(__dirname, "..", "driver", "dbx_zonepro1260.js"), "utf8");
    const sandbox = buildSandbox(config);
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox, { filename: "dbx_zonepro1260.js" });
    return sandbox;
}

// ------------------------------------------------------------ test helpers

function strToHex(s) {
    const out = [];
    for (let i = 0; i < s.length; i++) {
        out.push((s.charCodeAt(i) & 0xff).toString(16).toUpperCase().padStart(2, "0"));
    }
    return out.join(" ");
}

let failures = 0;
function check(name, actual, expected) {
    if (actual === expected) {
        console.log("OK   " + name);
    } else {
        failures++;
        console.log("FAIL " + name);
        console.log("  expected: " + expected);
        console.log("  actual  : " + actual);
    }
}

const baseConfig = {
    ConnectionType: "0",
    SerialPort: "12345",
    NodeAddress: "00 20",
    FaderMax: "415",
    Fader0dB: "215",
    CountsPerDb: "2",
    LevelStepDb: "1",
    DefaultLevel: "215",
    Debug: "false",
    Zone1Enabled: "true", Zone1ObjectID: "01 05 00 1E",
    Zone2Enabled: "true", Zone2ObjectID: "01 05 01 1F",
    Zone3Enabled: "true", Zone3ObjectID: "01 05 02 20",
    Zone4Enabled: "true", Zone4ObjectID: "01 05 03 21",
    Zone5Enabled: "true", Zone5ObjectID: "01 05 04 22",
    Zone6Enabled: "true", Zone6ObjectID: "01 05 05 23",
    Input1ObjectID: "01 04 00 05",
};

// ------------------------------------------------------------------- tests

// ---- serial mode
persistStore = {};
let sb = runDriver(baseConfig);

check("serial constructor args",
    JSON.stringify([serialArgs.port, serialArgs.baud, serialArgs.db, serialArgs.sb, serialArgs.par, serialArgs.hs]),
    JSON.stringify([12345, 57600, 8, 1, "None", "None"]));

// init: resync sequence = 16 x FF + 261 x F0
let resync = txLog.shift();
check("resync sequence length", String(resync.length), "277");
check("resync sequence content",
    strToHex(resync.slice(0, 17)) + " ... " + strToHex(resync.slice(-1)),
    "FF ".repeat(16).trim() + " F0 ... F0");

check("heartbeat interval", String(hbState.interval), "1000");

hbState.sendFn();
check("heartbeat ping", strToHex(txLog.shift()), "F0 8C");

sb.RecallScene(2);
check("RecallScene 2 (serial)", strToHex(txLog.shift()),
    "F0 64 00 01 00 00 00 17 00 33 00 00 00 00 00 20 00 00 00 00 90 01 00 00 00 02 64");
check("CurrentScene sysvar", String(sysvars.CurrentScene), "2");

sb.SelectSource(1, 1);
check("SelectSource zone1 input1 (serial)", strToHex(txLog.shift()),
    "F0 64 00 01 00 00 00 1B 00 33 01 05 00 1E 00 20 01 05 00 1E 01 00 00 00 00 01 00 00 01 01 5E");
check("Zone1Source sysvar", String(sysvars.Zone1Source), "1");

sb.SetLevelRaw(1, 215);
check("SetLevelRaw zone1 215 (serial)", strToHex(txLog.shift()),
    "F0 64 00 01 00 00 00 1C 00 33 01 05 00 1E 00 20 01 05 00 1E 01 00 00 00 00 01 00 01 03 00 D7 7C");
check("Zone1LevelPct sysvar", String(sysvars.Zone1LevelPct), "52");
check("Zone1LevelDb sysvar", String(sysvars.Zone1LevelDb), "0.0 dB");

sb.SetLevelPct(1, 100);
let f100 = strToHex(txLog.shift());
check("SetLevelPct 100 -> raw 415 value bytes", f100.substr(f100.length - 8, 5), "01 9F");

sb.LevelDown(1); // 1 dB step = 2 counts: 415 - 2 = 413 = 0x019D
let f = strToHex(txLog.shift());
check("LevelDown value bytes (1 dB = 2 counts)", f.substr(f.length - 8, 5), "01 9D");

sb.MuteOn(2);
check("MuteOn zone2 (serial)", strToHex(txLog.shift()),
    "F0 64 00 01 00 00 00 1B 00 33 01 05 01 1F 00 20 01 05 01 1F 01 00 00 00 00 01 00 02 01 01 E1");
check("Zone2Mute sysvar", String(sysvars.Zone2Mute), "true");

sb.MuteToggle(2);
let mt = strToHex(txLog.shift());
check("MuteToggle zone2 -> off (payload val 00)", mt.substr(mt.length - 5, 2), "00");
check("Zone2Mute sysvar after toggle", String(sysvars.Zone2Mute), "false");

sb.SetInputGainPct(1, 50); // 50% of 415 = 207.5 -> round 208 = 0x00D0
check("SetInputGainPct input1 50%", strToHex(txLog.shift()),
    "F0 64 00 01 00 00 00 1C 00 33 01 04 00 05 00 20 01 04 00 05 01 00 00 00 00 01 00 00 03 00 D0 79");

sb.SendCustom("01 00 00 00 1B 00 33 01 05 02 20 00 20 01 05 02 20 01 00 05 00 00 01 00 00 01 02");
check("SendCustom (section 3 ch3 phone page, flags 0500)", strToHex(txLog.shift()),
    "F0 64 00 01 00 00 00 1B 00 33 01 05 02 20 00 20 01 05 02 20 01 00 05 00 00 01 00 00 01 02 26");

// heartbeat RX handling: 0x8C triggers HeartbeatReceived
let before = hbState.received;
serialArgs.rx(String.fromCharCode(0x8c));
check("ping ack calls HeartbeatReceived", String(hbState.received - before), "1");

// resync-request flood triggers a resync transmission
serialArgs.rx(String.fromCharCode(0xff).repeat(300));
let resync2 = txLog.shift();
check("FF flood triggers resync", String(resync2 && resync2.length), "277");
// rate limited: a second flood while holdoff timer runs sends nothing
serialArgs.rx(String.fromCharCode(0xff).repeat(300));
check("resync rate limited", String(txLog.length), "0");

// online / offline transitions
hbState.connFn();
check("online sysvar", String(sysvars.Online), "true");
check("connected event", events[events.length - 1], "CONNECTED");
hbState.discFn();
check("offline sysvar", String(sysvars.Online), "false");
check("disconnected event", events[events.length - 1], "DISCONNECTED");

// disabled/invalid zone handling: no transmission, error printed
let errorsBefore = printed.length;
sb.SelectSource(9, 1);
check("invalid zone sends nothing", String(txLog.length), "0");
check("invalid zone prints error", String(printed.length > errorsBefore), "true");

// invalid hex must be rejected outright, not partially parsed (parseInt
// stops at the first bad char, so "2G" would otherwise become 0x02)
sb.SendCustom("01 00 2G");
check("SendCustom rejects invalid hex digit", String(txLog.length), "0");
sb.SendCustom("50%");
check("SendCustom rejects percent sign", String(txLog.length), "0");
check("error output sanitizes percent for System.Print",
    String(printed[printed.length - 1].indexOf("%") === -1), "true");

// a node-address typo must fall back to the default 00 20, not node 00 02
{
    const badCfg = Object.assign({}, baseConfig, { NodeAddress: "00 2G" });
    const savedStore = persistStore;
    persistStore = {};
    const sbBad = runDriver(badCfg);
    txLog.length = 0;
    sbBad.RecallScene(1);
    const frame = strToHex(txLog.shift());
    check("bad NodeAddress falls back to default 00 20",
        frame.substr(3 * 14, 5), "00 20"); // dest device at byte offset 14
    persistStore = savedStore;
}
sb = runDriver(baseConfig); // restore primary sandbox state for tests below
txLog.length = 0;
sb.SelectSource(1, 1); txLog.shift();
sb.SetLevelPct(1, 100); txLog.shift();
sb.LevelDown(1); txLog.shift();
sb.RecallScene(2); txLog.shift();

// ---- persistence round trip
// The driver's shutdown hook flushes any pending (timer-debounced) save.
sb.System.OnShutdownFunc();
let saved = persistStore["state_v1"];
check("persisted state exists", String(!!saved), "true");
check("persisted zone1 source/raw", saved.split(";")[0], "1,413,0");

let sb2 = runDriver(baseConfig); // same persistStore
txLog.length = 0;
check("restored zone1 source sysvar", String(sysvars.Zone1Source), "1");
check("restored zone1 level sysvar", String(sysvars.Zone1LevelPct), "100"); // round(413*100/415)
check("restored scene sysvar", String(sysvars.CurrentScene), "2");

// ---- TCP mode
persistStore = {};
let tcpConfig = Object.assign({}, baseConfig, {
    ConnectionType: "1", IPAddress: "10.1.5.205", IPPort: "3804",
});
let sb3 = runDriver(tcpConfig);
check("tcp constructor args", JSON.stringify([tcpArgs.host, tcpArgs.port]),
    JSON.stringify(["10.1.5.205", 3804]));
check("no resync/ping over tcp at init", String(txLog.length), "0");

sb3.SelectSource(1, 1);
check("SelectSource zone1 input1 (tcp, unframed)", strToHex(txLog.shift()),
    "01 00 00 00 1B 00 33 01 05 00 1E 00 20 01 05 00 1E 01 00 00 00 00 01 00 00 01 01");

// ------------------------------------------------------------------ summary

console.log("");
if (failures === 0) {
    console.log("ALL DRIVER JS TESTS PASSED");
} else {
    console.log(failures + " TEST(S) FAILED");
    process.exit(1);
}

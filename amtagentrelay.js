/**
* @description Aspendora patch: reach Intel AMT through an online mesh agent on the same LAN when there is no CIRA.
* @license Apache-2.0
*
* MeshCentral in WAN-only mode can only reach Intel AMT over CIRA. This module finds, for every activated
* Intel AMT device that is not CIRA connected, an online agent in the same device group (preferably on the
* same subnet) that can open a TCP connection to the device's AMT ports. When a probe through that agent
* succeeds, the device is flagged as "Intel AMT local" (connectivity bit 4) so the normal web UI enables
* Intel AMT KVM / MeshCommander, and webserver.js tunnels the session through the agent (meshrelay p=14,
* the same mechanism as Web-RDP / MeshCentral Router).
*
* If no LAN agent can reach it but the device's own agent is online, the route goes through that agent to
* 127.0.0.1 (the local Intel AMT service, LMS). That gives the Intel AMT tab (WSMAN: power, event log,
* settings). Redirection (KVM, SOL, IDE-R) does not work over LMS, so webserver.js refuses it on that route.
*
* Optional config: meshcentral-data/amtagentrelay.json
*   { "enabled": true, "probeIntervalSeconds": 600, "lms": true,
*     "targets": { "<nodeid or device name>": "10.2.1.62" },          // force the AMT address
*     "relays":  { "<nodeid, device name or meshid>": ["<relay nodeid>"] } } // force relay agents
*/

'use strict';

module.exports.CreateAmtAgentRelay = function (parent) {
    const obj = {};
    const WebSocket = require('ws');
    const { Duplex } = require('stream');
    const tls = require('tls');
    const constants = (require('crypto').constants ? require('crypto').constants : require('constants'));
    const PROBE_TIMEOUT = 12000;
    const MAX_PARALLEL = 4;
    const WATCH_INTERVAL = 30000;  // check for Intel AMT devices whose agent just went offline
    const OFFLINE_PROBE_DELAY = 20000;

    obj.routes = {};    // NodeId --> { relayid, relayname, addr, lms, meshid, name, time }
    obj.config = { enabled: true, probeIntervalSeconds: 600, lms: true, targets: {}, relays: {} };
    var timer = null, watchTimer = null, running = false;
    var amtNodeIds = [], agentWasOnline = {};

    // Load optional config
    try {
        const path = require('path').join(parent.datapath, 'amtagentrelay.json');
        if (require('fs').existsSync(path)) { Object.assign(obj.config, JSON.parse(require('fs').readFileSync(path, 'utf8'))); }
    } catch (ex) { console.log('AmtAgentRelay: unable to read amtagentrelay.json: ' + ex); }
    if (obj.config.enabled === false) { console.log('AmtAgentRelay: disabled by config.'); return obj; }

    function debug(msg) { parent.debug('amtrelay', msg); }

    // Same TLS options webserver.js uses for direct Intel AMT connections
    obj.tlsOptions = function () {
        return { ciphers: 'RSA+AES:!aNULL:!MD5:!DSS', secureOptions: constants.SSL_OP_NO_SSLv2 | constants.SSL_OP_NO_SSLv3 | constants.SSL_OP_NO_COMPRESSION | constants.SSL_OP_CIPHER_SERVER_PREFERENCE | constants.SSL_OP_ALLOW_UNSAFE_LEGACY_RENEGOTIATION, rejectUnauthorized: false, minVersion: 'TLSv1' };
    };

    function agentOnline(nodeid) { const a = (parent.webserver != null) ? parent.webserver.wsagents[nodeid] : null; return (a != null) && (a.authenticated == 2); }

    // Return the agent route for a node, or null. An LMS route is only valid while the device's own agent is online.
    obj.getRoute = function (nodeid) {
        const route = obj.routes[nodeid];
        if (route == null) return null;
        if (route.lms && !agentOnline(nodeid)) { setRoute({ _id: nodeid, meshid: route.meshid, name: route.name }, null); return null; }
        return route;
    };

    // Create a Duplex stream that is a TCP connection to addr:port, opened by the relay agent.
    // If userid is null, the relay is opened without user authentication (server probe).
    obj.createTunnel = function (relayid, addr, port, userid, domainid) {
        const cookieContent = { domainid: domainid, nodeid: relayid, tcpaddr: addr, tcpport: port };
        if (userid != null) { cookieContent.userid = userid; } else { cookieContent.nouser = 1; }
        const cookie = parent.encodeCookie(cookieContent, parent.loginCookieEncryptionKey);
        const domain = parent.config.domains[domainid];
        var domainadd = '';
        if ((domain != null) && (domain.dns == null) && (domainid != '')) { domainadd = domainid + '/'; }
        var url = (parent.args.tlsoffload ? 'ws' : 'wss') + '://localhost:' + parent.args.port + '/' + domainadd + 'meshrelay.ashx?p=14&auth=' + cookie;
        if (domainid != '') { url += '&domainid=' + domainid; }

        var active = false, pending = [], wsClient = null;
        const d = new Duplex({
            read: function () { if ((wsClient != null) && (wsClient._socket != null)) { try { wsClient._socket.resume(); } catch (ex) { } } },
            write: function (chunk, encoding, cb) {
                if (active == false) { pending.push([chunk, cb]); return; }
                try { wsClient.send(chunk, { binary: true }, function (err) { cb(err); }); } catch (ex) { cb(ex); }
            },
            final: function (cb) { if (wsClient != null) { try { wsClient.close(); } catch (ex) { } } cb(); },
            destroy: function (err, cb) { active = false; if (wsClient != null) { try { wsClient.terminate(); } catch (ex) { } wsClient = null; } cb(err); }
        });
        d.relayid = relayid;
        d.tcpaddr = addr;
        d.tcpport = port;

        // net.Socket compatible connect(): the TCP connection is up once the relay is paired
        d.connect = function (p, h, func) { if (func) { if (active) { func(); } else { d.once('relayconnect', func); } } return d; };

        wsClient = new WebSocket(url, { rejectUnauthorized: false });
        wsClient.on('message', function (data, isBinary) {
            if (active == false) {
                if ((isBinary == false) && ((data.toString() == 'c') || (data.toString() == 'cr'))) {
                    active = true;
                    debug('Tunnel via ' + relayid + ' to ' + addr + ':' + port + ' connected');
                    const p = pending; pending = [];
                    for (var i in p) { const x = p[i]; try { wsClient.send(x[0], { binary: true }, function (err) { x[1](err); }); } catch (ex) { x[1](ex); } }
                    d.emit('relayconnect');
                }
                return;
            }
            if (isBinary == false) {
                try { const cmd = JSON.parse(data.toString()); if ((cmd != null) && (cmd.ctrlChannel == '102938')) return; } catch (ex) { }
            }
            if (d.push(Buffer.from(data)) == false) { try { wsClient._socket.pause(); } catch (ex) { } }
        });
        wsClient.on('close', function () { d.push(null); d.destroy(); });
        wsClient.on('error', function (err) { d.destroy(err); });
        return d;
    };

    // Probe Intel AMT at addr through relayid. Calls func(true) if AMT answered.
    function probe(relayid, addr, useTls, domainid, func) {
        const port = useTls ? 16993 : 16992;
        var done = false, tunnel = null, sock = null;
        function finish(result) {
            if (done) return; done = true; clearTimeout(t);
            try { if (sock && (sock != tunnel)) { sock.destroy(); } } catch (ex) { }
            try { if (tunnel) { tunnel.destroy(); } } catch (ex) { }
            func(result);
        }
        const t = setTimeout(function () { finish(false); }, PROBE_TIMEOUT);
        try { tunnel = obj.createTunnel(relayid, addr, port, null, domainid); } catch (ex) { finish(false); return; }
        tunnel.on('error', function () { finish(false); });
        tunnel.on('close', function () { finish(false); });
        if (useTls) {
            const o = obj.tlsOptions(); o.socket = tunnel;
            try { sock = tls.connect(o, function () { finish(true); }); } catch (ex) { finish(false); return; }
            sock.on('error', function () { finish(false); });
        } else {
            sock = tunnel;
            tunnel.on('data', function (data) { finish(data.toString('binary', 0, 7) == 'HTTP/1.'); });
            tunnel.write(Buffer.from('GET /index.htm HTTP/1.1\r\nHost: ' + addr + ':16992\r\n\r\n', 'binary'));
        }
    }

    function ipToInt(ip) { const p = ip.split('.'); if (p.length != 4) return null; return ((parseInt(p[0]) << 24) | (parseInt(p[1]) << 16) | (parseInt(p[2]) << 8) | parseInt(p[3])) >>> 0; }
    function isIPv4(s) { return (typeof s == 'string') && /^\d{1,3}(\.\d{1,3}){3}$/.test(s); }

    // Return the IPv4 networks (address + netmask) from a netif2 record
    function getV4(netif2, wiredOnly) {
        const r = [];
        if (netif2 == null) return r;
        for (var name in netif2) {
            for (var i in netif2[name]) {
                const a = netif2[name][i];
                if ((a.family != 'IPv4') || !isIPv4(a.address) || a.address.startsWith('169.254.') || a.address.startsWith('127.')) continue;
                if (wiredOnly && (a.type != 'ethernet')) continue;
                r.push({ address: a.address, netmask: a.netmask, up: (a.status == 'up') });
            }
        }
        r.sort(function (x, y) { return (y.up ? 1 : 0) - (x.up ? 1 : 0); });
        return r;
    }

    function sameSubnet(addr, nets) {
        const ai = ipToInt(addr);
        if (ai == null) return false;
        for (var i in nets) {
            const ni = ipToInt(nets[i].address), mi = isIPv4(nets[i].netmask) ? ipToInt(nets[i].netmask) : 0xFFFFFF00;
            if ((ni != null) && ((ni & mi) == (ai & mi))) return true;
        }
        return false;
    }

    function getNetif(nodeid, func) {
        parent.db.Get('if' + nodeid, function (err, docs) { func(((err == null) && (docs != null) && (docs.length == 1)) ? docs[0].netif2 : null); });
    }

    function lookup(map, node) {
        if (map == null) return null;
        if (map[node._id] != null) return map[node._id];
        if (map[node.name] != null) return map[node.name];
        if (map[node.meshid] != null) return map[node.meshid];
        return null;
    }

    function setRoute(node, route) {
        const old = obj.routes[node._id];
        if (route != null) {
            route.meshid = node.meshid; route.name = node.name;
            obj.routes[node._id] = route;
            if ((old == null) || (old.relayid != route.relayid) || (old.addr != route.addr)) {
                console.log('AmtAgentRelay: ' + node.name + ' Intel AMT reachable at ' + route.addr + ' via agent ' + route.relayname + (route.lms ? ' (LMS, no KVM)' : '') + '.');
            }
            parent.SetConnectivityState(node.meshid, node._id, Date.now(), 4, 7, null, { name: node.name }); // Intel AMT "local", power "present"
        } else if (old != null) {
            delete obj.routes[node._id];
            console.log('AmtAgentRelay: ' + node.name + ' Intel AMT no longer reachable via agent ' + old.relayname + '.');
            parent.ClearConnectivityState(node.meshid, node._id, 4, null, { name: node.name });
        }
    }

    // Find and test a route for one node
    function checkNode(node, func) {
        const state = parent.GetConnectivityState(node._id);
        if ((state != null) && ((state.connectivity & 2) != 0)) { setRoute(node, null); func(); return; } // CIRA is connected, prefer it
        const wsagents = parent.webserver.wsagents;

        getNetif(node._id, function (netif2) {
            // Candidate Intel AMT addresses
            const addrs = [];
            const forced = lookup(obj.config.targets, node);
            if (forced) { addrs.push(forced); }
            else {
                const v4 = getV4(netif2, true);
                for (var i in v4) { if (addrs.indexOf(v4[i].address) < 0) { addrs.push(v4[i].address); } }
                if ((typeof node.intelamt.host == 'string') && (node.intelamt.host.length > 0) && (addrs.indexOf(node.intelamt.host) < 0)) { addrs.push(node.intelamt.host); }
            }
            if (addrs.length == 0) { tryLms(node, func); return; }

            // Candidate relay agents, online, same device group, not the device itself
            var relays = [];
            const forcedRelays = lookup(obj.config.relays, node);
            if (Array.isArray(forcedRelays)) {
                for (var i in forcedRelays) { const a = wsagents[forcedRelays[i]]; if ((a != null) && (a.authenticated == 2)) { relays.push({ id: a.dbNodeKey, name: a.name }); } }
            } else {
                for (var id in wsagents) {
                    const a = wsagents[id];
                    if ((a.authenticated == 2) && (a.dbMeshKey == node.meshid) && (a.dbNodeKey != node._id)) { relays.push({ id: a.dbNodeKey, name: a.name }); }
                }
            }
            if (relays.length == 0) { tryLms(node, func); return; }

            // Get relay netifs to prefer agents on the same subnet as the first IPv4 candidate
            var pendingIf = relays.length;
            for (var i in relays) {
                (function (r) {
                    getNetif(r.id, function (rn) {
                        r.nets = getV4(rn, false);
                        if (--pendingIf == 0) { tryRoutes(node, addrs, relays, func); }
                    });
                })(relays[i]);
            }
        });
    }

    function tryRoutes(node, addrs, relays, func) {
        // Build the list of (relay, addr) attempts: existing route first, then same-subnet relays, max 3 relays per address
        const attempts = [];
        const old = obj.routes[node._id];
        if (old && (addrs.indexOf(old.addr) >= 0)) { for (var i in relays) { if (relays[i].id == old.relayid) { attempts.push({ relay: relays[i], addr: old.addr }); } } }
        for (var j in addrs) {
            const addr = addrs[j];
            var list = relays;
            if (isIPv4(addr)) {
                list = relays.filter(function (r) { return sameSubnet(addr, r.nets); });
                if (list.length == 0) continue; // No agent on that subnet, skip this address
            }
            for (var k = 0; (k < list.length) && (k < 3); k++) { attempts.push({ relay: list[k], addr: addr }); }
        }
        const useTls = (node.intelamt.tls > 0);
        (function next(i) {
            if (i >= attempts.length) { tryLms(node, func); return; }
            const a = attempts[i];
            probe(a.relay.id, a.addr, useTls, node.domain, function (ok) {
                debug('Probe ' + node.name + ' at ' + a.addr + ' via ' + a.relay.name + ': ' + ok);
                if (ok) { setRoute(node, { relayid: a.relay.id, relayname: a.relay.name, addr: a.addr, time: Date.now() }); func(); } else { next(i + 1); }
            });
        })(0);
    }

    // Last resort: the device's own agent to the local Intel AMT service (LMS) on 127.0.0.1
    function tryLms(node, func) {
        if ((obj.config.lms === false) || !agentOnline(node._id)) { setRoute(node, null); func(); return; }
        probe(node._id, '127.0.0.1', (node.intelamt.tls > 0), node.domain, function (ok) {
            debug('Probe ' + node.name + ' at 127.0.0.1 (LMS) via own agent: ' + ok);
            setRoute(node, ok ? { relayid: node._id, relayname: node.name, addr: '127.0.0.1', lms: true, time: Date.now() } : null);
            func();
        });
    }

    // Probe all activated Intel AMT devices that are not CIRA connected
    obj.run = function () {
        if (running || (parent.webserver == null)) return;
        running = true;
        parent.db.GetAllType('node', function (err, docs) {
            if ((err != null) || (docs == null)) { running = false; return; }
            const nodes = docs.filter(function (n) { return (n.intelamt != null) && (n.intelamt.state == 2) && (typeof n.intelamt.user == 'string') && (n.intelamt.user.length > 0); });
            // Forget routes for nodes that disappeared or were deactivated
            const ids = nodes.map(function (n) { return n._id; });
            for (var id in obj.routes) { if (ids.indexOf(id) < 0) { delete obj.routes[id]; } }
            amtNodeIds = ids;
            var index = 0, active = 0;
            function pump() {
                if ((index >= nodes.length) && (active == 0)) { running = false; return; }
                while ((active < MAX_PARALLEL) && (index < nodes.length)) {
                    const n = nodes[index++]; active++;
                    try { checkNode(n, function () { active--; pump(); }); } catch (ex) { console.log('AmtAgentRelay: ' + ex); active--; }
                }
            }
            pump();
        });
    };

    // Re-probe one node now (used when a session fails)
    obj.probeNode = function (nodeid) {
        parent.db.Get(nodeid, function (err, docs) { if ((err == null) && (docs != null) && (docs.length == 1) && (docs[0].intelamt != null)) { checkNode(docs[0], function () { }); } });
    };

    // When an Intel AMT device's agent goes offline, drop its LMS route and re-probe it shortly after:
    // with the OS down, shared-IP Intel AMT owns the IP again and a LAN agent may now reach it.
    obj.watch = function () {
        if (parent.webserver == null) return;
        for (var i in amtNodeIds) {
            const id = amtNodeIds[i], online = agentOnline(id);
            if ((agentWasOnline[id] === true) && !online) {
                obj.getRoute(id); // drops an LMS route
                setTimeout(function () { obj.probeNode(id); }, OFFLINE_PROBE_DELAY);
            }
            agentWasOnline[id] = online;
        }
    };

    setTimeout(obj.run, 60000);
    watchTimer = setInterval(obj.watch, WATCH_INTERVAL);
    timer = setInterval(obj.run, Math.max(60, obj.config.probeIntervalSeconds) * 1000);
    console.log('AmtAgentRelay: enabled, probing every ' + Math.max(60, obj.config.probeIntervalSeconds) + ' seconds.');
    return obj;
};

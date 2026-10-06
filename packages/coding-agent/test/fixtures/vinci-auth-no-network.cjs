const { appendFileSync } = require("node:fs");
const { syncBuiltinESMExports } = require("node:module");
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const tls = require("node:tls");

// Fail closed before any test request leaves the process. Never record request data.
function denyNetwork() {
	appendFileSync(process.env.VINCI_AUTH_TEST_EVENTS, "network\n");
	throw new Error("Network access is forbidden in the auth guidance fixture");
}

globalThis.fetch = denyNetwork;
http.request = denyNetwork;
http.get = denyNetwork;
https.request = denyNetwork;
https.get = denyNetwork;
net.Socket.prototype.connect = denyNetwork;
tls.connect = denyNetwork;
syncBuiltinESMExports();

#!/usr/bin/env node
/* Local dev server for the Card2Leads Admin SPA.
 *
 * Serves ./public and reverse-proxies /api/* to the running backend, so the
 * browser sees ONE origin (this port) and the admin session cookie is
 * first-party — no CORS, no SameSite headaches. This mirrors the production
 * setup where the admin subdomain's nginx proxies /api to the app backend.
 *
 *   API_TARGET=http://localhost:3000 PORT=4100 node dev-server.js
 */
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT || 4100);
const API_TARGET = process.env.API_TARGET || "http://localhost:5173";
const PUBLIC_DIR = path.join(__dirname, "public");
const target = new URL(API_TARGET);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8"
};

function proxy(req, res) {
  const opts = {
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || (target.protocol === "https:" ? 443 : 80),
    method: req.method,
    path: req.url,
    headers: Object.assign({}, req.headers, { host: target.host })
  };
  const lib = target.protocol === "https:" ? require("https") : http;
  const up = lib.request(opts, (upRes) => {
    res.writeHead(upRes.statusCode, upRes.headers);
    upRes.pipe(res);
  });
  up.on("error", (err) => {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Backend unreachable at " + API_TARGET + " (" + err.message + ")" }));
  });
  req.pipe(up);
}

function serveStatic(req, res) {
  let pathname = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (pathname === "/") pathname = "/index.html";
  let filePath = path.join(PUBLIC_DIR, pathname);
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end("Forbidden"); }
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      // SPA fallback: unknown non-file paths get index.html.
      if (!path.extname(pathname)) return fs.readFile(path.join(PUBLIC_DIR, "index.html"), (e2, idx) => {
        if (e2) { res.writeHead(404); return res.end("Not found"); }
        res.writeHead(200, { "Content-Type": MIME[".html"] }); res.end(idx);
      });
      res.writeHead(404); return res.end("Not found");
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
    res.end(buf);
  });
}

http.createServer((req, res) => {
  if (req.url.startsWith("/api/")) return proxy(req, res);
  return serveStatic(req, res);
}).listen(PORT, () => {
  console.log("Card2Leads Admin (dev) → http://localhost:" + PORT);
  console.log("Proxying /api/* → " + API_TARGET);
});

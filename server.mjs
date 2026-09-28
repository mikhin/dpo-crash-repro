import { createServer } from "node:https";
import { appendFileSync, readFileSync } from "node:fs";

const PORT = 8787;
const ORIGIN = `https://localhost:${PORT}`;
const tls = {
  key: readFileSync(new URL("./certs/key.pem", import.meta.url)),
  cert: readFileSync(new URL("./certs/cert.pem", import.meta.url)),
};
const REPORTS_FILE = new URL("./reports.jsonl", import.meta.url);

const observerHeaders = {
  "Reporting-Endpoints": `dpo="${ORIGIN}/reports"`,
  "Performance-Observer":
    'report-to="dpo", entry-types=("navigation" "mark" "visibility-state"), include-user-timing=("score")',
};

const readBody = (req) =>
  new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => resolve(body));
  });

createServer(tls, async (req, res) => {
  const { pathname } = new URL(req.url, ORIGIN);

  if (req.method === "POST" && pathname === "/reports") {
    const body = await readBody(req);
    const receivedAt = new Date().toISOString();
    appendFileSync(REPORTS_FILE, JSON.stringify({ receivedAt, reports: JSON.parse(body) }) + "\n");
    console.log(`[${receivedAt}] report\n${body}\n`);
    res.writeHead(204).end();
    return;
  }

  if (req.method === "GET" && pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", ...observerHeaders });
    res.end(readFileSync(new URL("./index.html", import.meta.url)));
    return;
  }

  res.writeHead(404).end();
}).listen(PORT, () => console.log(`${ORIGIN}/`));

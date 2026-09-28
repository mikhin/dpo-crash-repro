import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const DEBUG_PORT = 9333;
const PAGE = "https://localhost:8787/";
const REPORTS_FILE = new URL("./reports.jsonl", import.meta.url);
const headed = process.argv.includes("--headed");

const chrome = spawn(CHROME, [
  ...(headed ? [] : ["--headless=new"]),
  `--user-data-dir=${mkdtempSync(join(tmpdir(), "dpo-profile-"))}`,
  "--enable-features=DeclarativePerformanceObserver",
  "--short-reporting-delay",
  "--ignore-certificate-errors",
  "--no-first-run",
  "--no-default-browser-check",
  `--remote-debugging-port=${DEBUG_PORT}`,
  ...(process.env.EXTRA_FLAGS?.split(" ") ?? []),
  "about:blank",
]);

const waitForDebugger = async () => {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      return await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).json();
    } catch {
      await sleep(200);
    }
  }
  throw new Error("Chrome did not open the debugging port");
};

const { webSocketDebuggerUrl, Browser } = await waitForDebugger();
console.log(Browser);

const socket = new WebSocket(webSocketDebuggerUrl);
await new Promise((resolve) => socket.addEventListener("open", resolve, { once: true }));

let nextId = 1;
const pending = new Map();
const crashedSessions = new Set();
socket.addEventListener("message", ({ data }) => {
  const message = JSON.parse(data);
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
  }
  if (message.method === "Inspector.targetCrashed") crashedSessions.add(message.sessionId);
});

const send = (method, params = {}, sessionId) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    socket.send(JSON.stringify({ id, method, params, sessionId }));
  });

const openPage = async (scenario) => {
  const { result } = await send("Target.createTarget", { url: "about:blank" });
  const { result: attached } = await send("Target.attachToTarget", { targetId: result.targetId, flatten: true });
  await send("Inspector.enable", {}, attached.sessionId);
  await send("Page.navigate", { url: `${PAGE}?scenario=${scenario}` }, attached.sessionId);
  await sleep(1500);
  return { targetId: result.targetId, sessionId: attached.sessionId };
};

const markScore = (sessionId, times) =>
  send("Runtime.evaluate", { expression: `for (let i = 0; i < ${times}; i++) document.querySelector("#score").click()` }, sessionId);

const waitForCrash = async (sessionId) => {
  const deadline = Date.now() + 90_000;
  while (!crashedSessions.has(sessionId) && Date.now() < deadline) await sleep(500);
  console.log(crashedSessions.has(sessionId) ? "  renderer crashed" : "  renderer did NOT crash within 90 s");
};

const observersDestroyed = async () => {
  const { result } = await send("Browser.getHistogram", { name: "DeclarativePerformanceObserver.PeakBufferSize" });
  return result?.histogram.count ?? 0;
};

const logObserversDestroyed = async (moment) => console.log(`  observers destroyed ${moment}: ${await observersDestroyed()}`);

const reportsFor = (scenario) =>
  existsSync(REPORTS_FILE)
    ? readFileSync(REPORTS_FILE, "utf8")
        .trim()
        .split("\n")
        .flatMap((line) => JSON.parse(line).reports)
        .filter((report) => report.type === "performance-observer" && report.url.includes(`scenario=${scenario}`))
    : [];

const waitForReport = async (scenario, timeoutMs = 30_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const reports = reportsFor(scenario);
    if (reports.length) return reports;
    await sleep(500);
  }
  return [];
};

const summarize = (reports) =>
  reports.flatMap((report) =>
    report.body.entries.map((entry) =>
      [entry.entryType, entry.name, Math.round(entry.startTime), entry.detail ? JSON.stringify(entry.detail) : ""].join(" "),
    ),
  );

const scenarios = {
  close: async () => {
    const { targetId, sessionId } = await openPage("close");
    await markScore(sessionId, 3);
    await sleep(500);
    await send("Target.closeTarget", { targetId });
  },
  "crash-then-reload": async () => {
    const { sessionId } = await openPage("crash-then-reload");
    await markScore(sessionId, 3);
    await sleep(500);
    send("Page.crash", {}, sessionId);
    await waitForCrash(sessionId);
    await send("Page.reload", {}, sessionId);
  },
  "crash-then-close": async () => {
    const { targetId, sessionId } = await openPage("crash-then-close");
    await markScore(sessionId, 3);
    await sleep(500);
    send("Page.crash", {}, sessionId);
    await waitForCrash(sessionId);
    await send("Target.closeTarget", { targetId });
  },
  "console-oom": async () => {
    const { sessionId } = await openPage("console-oom");
    await markScore(sessionId, 3);
    await sleep(500);
    send("Runtime.evaluate", { expression: "const a = []; for (;;) a.push(new Array(1e7).fill(1));" }, sessionId);
    await waitForCrash(sessionId);
    await send("Page.reload", {}, sessionId);
  },
  "navigate-probe": async () => {
    const { sessionId } = await openPage("navigate-probe");
    await markScore(sessionId, 3);
    await sleep(500);
    await logObserversDestroyed("before navigating away");
    await send("Page.navigate", { url: "about:blank" }, sessionId);
    await sleep(2000);
    await logObserversDestroyed("after navigating away");
  },
  "crash-probe": async () => {
    const { sessionId } = await openPage("crash-probe");
    await markScore(sessionId, 3);
    await sleep(500);
    await logObserversDestroyed("before crash");
    send("Page.crash", {}, sessionId);
    await waitForCrash(sessionId);
    await logObserversDestroyed("after crash");
    await send("Page.navigate", { url: "about:blank" }, sessionId);
    await sleep(2000);
    await logObserversDestroyed("after navigating the crashed tab away");
  },
};

const only = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
for (const [name, run] of Object.entries(scenarios)) {
  if (only.length && !only.includes(name)) continue;
  console.log(`\n== ${name}`);
  const startedAt = Date.now();
  await run();
  const reports = await waitForReport(name);
  console.log(reports.length ? `  report after ${Date.now() - startedAt} ms` : "  NO REPORT within 30 s");
  for (const line of summarize(reports)) console.log(`  ${line}`);
}

socket.close();
chrome.kill();
process.exit();

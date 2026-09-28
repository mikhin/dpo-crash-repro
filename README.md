# Declarative Performance Observer: no report after a renderer crash

A `performance-observer` report reaches the endpoint when the tab is closed, but not when the renderer crashes, even after the crashed tab is reloaded or closed. The explainer's [use case 2](https://github.com/explainers-by-googlers/declarative-performance-observer#use-case-2-measuring-application-journeys-terminated-by-oom-crashes) expects it to.

Tracked in [crbug.com/558351483](https://issues.chromium.org/issues/558351483).

## Run

Node 22+, Chrome 154+ (or Chrome for Testing), openssl.

```sh
mkdir -p certs && openssl req -x509 -newkey rsa:2048 -nodes -days 365 -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost" -keyout certs/key.pem -out certs/cert.pem
node server.mjs
node repro.mjs                                # every scenario, headless
node repro.mjs --headed close console-oom     # some scenarios, in a window
CHROME=/path/to/chrome node repro.mjs         # another Chrome build
```

`server.mjs` serves the page over HTTPS with `Reporting-Endpoints` and `Performance-Observer` and writes received reports to `reports.jsonl`. `repro.mjs` starts Chrome with `--enable-features=DeclarativePerformanceObserver --short-reporting-delay` and drives it over CDP.

| Scenario | What happens | Report |
|---|---|---|
| `close` | 3 marks, close the tab | arrives in ~3 s |
| `crash-then-reload` | 3 marks, `Page.crash`, reload | none in 30 s |
| `crash-then-close` | 3 marks, `Page.crash`, close the tab | none in 30 s |
| `console-oom` | 3 marks, Out of Memory loop via `Runtime.evaluate`, reload | none in 30 s |
| `crash-probe` | 3 marks, `Page.crash`, navigate the crashed tab away | none in 30 s |
| `navigate-probe` | 3 marks, navigate away | arrives |

The probes print the sample count of `DeclarativePerformanceObserver.PeakBufferSize` at each step. With `EXTRA_FLAGS=--disable-features=BackForwardCache`, `navigate-probe` shows the count going up by one on navigation and the report arriving. `crash-probe` shows the count unchanged by the crash, going up by one only when the crashed tab navigates away, and no report.

Seen on Chrome for Testing 156.0.8076.0, macOS arm64, headless and headed. `crash-then-reload` and `crash-then-close` also give no report on 154.0.8037.57.

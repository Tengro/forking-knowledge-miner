/** Minimal dependency-free viewer for the authenticated retrieval trace endpoint. */
export const RETRIEVAL_TRACE_PAGE_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Retrieval traces</title>
<style>
  :root { color-scheme: dark; font: 15px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; }
  body { max-width: 1100px; margin: 2rem auto; padding: 0 1rem; background: #0c0e14; color: #d8deea; }
  header { display: flex; gap: 1rem; align-items: center; flex-wrap: wrap; margin-bottom: 1rem; }
  h1 { font: 600 1.4rem/1.2 system-ui, sans-serif; margin: 0 auto 0 0; }
  button, label { font: inherit; }
  button { padding: .35rem .7rem; background: #1c2434; color: inherit; border: 1px solid #3a4863; border-radius: .35rem; }
  .note { color: #9ca9bd; margin: .5rem 0 1.25rem; }
  details { border: 1px solid #283247; border-radius: .45rem; margin: .65rem 0; background: #111722; }
  summary { cursor: pointer; padding: .7rem .85rem; color: #e7bf76; }
  pre { white-space: pre-wrap; overflow-wrap: anywhere; margin: 0; padding: .85rem; border-top: 1px solid #283247; color: #c8d4e8; }
  .error { color: #ff8e8e; }
</style>
</head>
<body>
<header>
  <h1>Retrieval traces</h1>
  <label><input id="inputs" type="checkbox"> include exact conversation inputs</label>
  <button id="refresh" type="button">refresh</button>
</header>
<p class="note">Newest first. In-memory only; reset on Host restart. “Raw output” is selector text returned to the application, not hidden chain-of-thought.</p>
<div id="status" class="note"></div>
<main id="traces"></main>
<script>
const root = document.getElementById('traces');
const status = document.getElementById('status');
const inputs = document.getElementById('inputs');

function summary(trace) {
  const selected = trace.injected && trace.injected.lessonIds ? trace.injected.lessonIds.join(', ') : '';
  return '#' + trace.id + '  ' + (trace.outcome || 'running') + '  ' + trace.startedAt +
    (selected ? '  selected: ' + selected : '');
}

async function load() {
  status.textContent = 'loading…';
  root.replaceChildren();
  try {
    const url = '/debug/retrieval?limit=100&includeInputs=' + (inputs.checked ? '1' : '0');
    const response = await fetch(url, { credentials: 'same-origin' });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || ('HTTP ' + response.status));
    status.textContent = payload.enabled
      ? payload.traces.length + ' retained run(s)'
      : 'retrieval module is not enabled';
    for (const trace of payload.traces) {
      const details = document.createElement('details');
      const label = document.createElement('summary');
      const pre = document.createElement('pre');
      label.textContent = summary(trace);
      pre.textContent = JSON.stringify(trace, null, 2);
      details.append(label, pre);
      root.append(details);
    }
  } catch (error) {
    status.textContent = String(error);
    status.className = 'error';
  }
}

document.getElementById('refresh').addEventListener('click', load);
inputs.addEventListener('change', load);
load();
</script>
</body>
</html>`;

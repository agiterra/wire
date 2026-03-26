/**
 * Dashboard HTML — monospace dark-mode agent registry.
 * Passkey auth on a monospace dark-mode agent registry — peak infrastructure.
 */

export function renderDashboard(agents: any[], operatorName: string): string {
  const agentRows = agents.map((a: any) => {
    const status = a.online ? "●" : "○";
    const statusColor = a.online ? "#4ade80" : "#6b7280";
    const planSnippet = a.plan ? a.plan.slice(0, 80) + (a.plan.length > 80 ? "…" : "") : "—";
    const lastSeen = a.last_seen_at ? new Date(a.last_seen_at).toLocaleString() : "never";
    const pubkeyShort = a.pubkey ? a.pubkey.slice(0, 16) + "…" : "—";
    return `
      <tr>
        <td><span style="color:${statusColor}">${status}</span></td>
        <td class="agent-name copyable" onclick="copy('${esc(a.id)}')" title="Click to copy">${esc(a.id)}</td>
        <td>${esc(a.display_name)}</td>
        <td class="copyable" onclick="copy('${esc(a.pubkey)}')" title="Click to copy full pubkey">${pubkeyShort}</td>
        <td>${a.sessions}</td>
        <td class="plan">${esc(planSnippet)}</td>
        <td class="dim">${lastSeen}</td>
      </tr>`;
  }).join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>The Wire</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: #0a0a0a;
      color: #e5e5e5;
      font-family: 'SF Mono', 'Fira Code', 'JetBrains Mono', monospace;
      font-size: 13px;
      line-height: 1.6;
      padding: 24px;
    }
    header {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      border-bottom: 1px solid #262626;
      padding-bottom: 12px;
      margin-bottom: 24px;
    }
    h1 { font-size: 16px; font-weight: 600; color: #fafafa; }
    h1 span { color: #6b7280; font-weight: 400; }
    .operator { color: #6b7280; font-size: 12px; }
    .operator a { color: #6b7280; text-decoration: none; }
    .operator a:hover { color: #e5e5e5; }
    h2 {
      font-size: 13px;
      font-weight: 600;
      color: #a1a1aa;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 8px;
    }
    table { width: 100%; border-collapse: collapse; }
    th {
      text-align: left;
      color: #6b7280;
      font-weight: 500;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      padding: 6px 12px 6px 0;
      border-bottom: 1px solid #1f1f1f;
    }
    td {
      padding: 8px 12px 8px 0;
      border-bottom: 1px solid #141414;
      vertical-align: top;
    }
    tr:hover { background: #111; }
    .agent-name { color: #60a5fa; font-weight: 500; }
    .plan { color: #a1a1aa; max-width: 400px; }
    .dim { color: #525252; }
    .copyable { cursor: pointer; }
    .copyable:hover { text-decoration: underline; }
    .copied { color: #4ade80 !important; }
    .form-section {
      margin-top: 32px;
      padding-top: 16px;
      border-top: 1px solid #1f1f1f;
    }
    .form-row {
      display: flex;
      gap: 8px;
      margin-bottom: 8px;
      align-items: center;
    }
    .form-row input, .form-row select {
      background: #1a1a1a;
      border: 1px solid #333;
      color: #e5e5e5;
      padding: 6px 10px;
      font-family: inherit;
      font-size: 12px;
      border-radius: 4px;
    }
    .form-row input:focus { outline: none; border-color: #60a5fa; }
    .form-row button {
      background: #262626;
      color: #e5e5e5;
      border: 1px solid #333;
      padding: 6px 12px;
      font-family: inherit;
      font-size: 12px;
      border-radius: 4px;
      cursor: pointer;
    }
    .form-row button:hover { background: #333; }
    .form-row button.primary { background: #fafafa; color: #0a0a0a; border-color: #fafafa; }
    .form-row button.primary:hover { background: #d4d4d8; }
    .key-output {
      background: #111;
      border: 1px solid #262626;
      border-radius: 4px;
      padding: 12px;
      margin-top: 8px;
      display: none;
      font-size: 11px;
      word-break: break-all;
    }
    .key-output label { color: #6b7280; display: block; margin-bottom: 2px; }
    .key-output .key-val {
      color: #fbbf24;
      cursor: pointer;
      padding: 4px 0;
    }
    .key-output .key-val:hover { text-decoration: underline; }
    .key-output .warning { color: #f87171; font-size: 10px; margin-top: 8px; }
    #message-log {
      max-height: 300px;
      overflow-y: auto;
      background: #111;
      border: 1px solid #1f1f1f;
      border-radius: 4px;
      padding: 8px 12px;
      margin-bottom: 24px;
    }
    #message-log:empty::after {
      content: 'Waiting for messages…';
      color: #3f3f46;
    }
    .msg-entry {
      padding: 3px 0;
      border-bottom: 1px solid #141414;
      display: flex;
      gap: 12px;
      align-items: baseline;
    }
    .msg-entry:last-child { border-bottom: none; }
    .msg-ts { color: #525252; font-size: 11px; min-width: 80px; }
    .msg-seq { color: #6b7280; font-size: 11px; min-width: 40px; }
    .msg-source { color: #60a5fa; min-width: 100px; }
    .msg-arrow { color: #3f3f46; }
    .msg-dest { color: #a78bfa; min-width: 100px; }
    .msg-topic { color: #fbbf24; flex: 1; }
    .msg-delivery { font-size: 11px; }
    .msg-delivery .ok { color: #4ade80; }
    .msg-delivery .skip { color: #f87171; }
    .tasks-list { margin-bottom: 8px; padding-left: 0; }
    .tasks-list ol { margin: 0; padding-left: 24px; list-style: decimal; }
    .tasks-list ol li { color: #525252; padding: 0; margin: 0; }
    .task-row {
      display: flex;
      align-items: baseline;
      gap: 12px;
      padding: 6px 0;
      border-bottom: 1px solid #141414;
      cursor: pointer;
    }
    .task-row:hover { background: #111; }
    .task-title { color: #e5e5e5; flex: 1; }
    .task-owner { color: #6b7280; font-size: 11px; min-width: 80px; }
    .task-status { font-size: 11px; min-width: 100px; text-align: right; }
    .task-status.done { color: #4ade80; }
    .task-status.in_progress, .task-status.code_complete { color: #fbbf24; }
    .task-status.blocked { color: #f87171; }
    .task-status.not_started, .task-status.ready { color: #6b7280; }
    .task-status.planned { color: #a78bfa; }
    .task-details { color: #525252; font-size: 11px; padding: 2px 0 4px 12px; display: none; }
    .task-row.expanded + .task-details { display: block; }
    .stats {
      display: flex;
      gap: 32px;
      margin-bottom: 24px;
      color: #a1a1aa;
    }
    .stat-value { color: #fafafa; font-weight: 600; }
    footer {
      margin-top: 32px;
      padding-top: 12px;
      border-top: 1px solid #1f1f1f;
      color: #3f3f46;
      font-size: 11px;
    }
  </style>
</head>
<body>
  <header>
    <h1>The Wire <span>v0.3.0</span></h1>
    <div class="operator">${esc(operatorName)} · <a href="/auth/logout">logout</a></div>
  </header>

  <div class="stats">
    <div><span class="stat-value">${agents.length}</span> agents</div>
    <div><span class="stat-value">${agents.filter((a: any) => a.online).length}</span> online</div>
    <div><span class="stat-value">${agents.reduce((n: number, a: any) => n + a.sessions, 0)}</span> sessions</div>
  </div>

  <h2>Agent Registry</h2>
  <table>
    <thead>
      <tr>
        <th></th>
        <th>ID</th>
        <th>Name</th>
        <th>Pubkey</th>
        <th>Sessions</th>
        <th>Plan</th>
        <th>Last Seen</th>
      </tr>
    </thead>
    <tbody>
      ${agentRows}
    </tbody>
  </table>

  <div class="form-section">
    <h2>Message Log</h2>
    <div id="message-log"></div>
  </div>

  <div class="form-section" id="tasks-section">
    <h2>Tasks</h2>
    <div id="tasks-list" class="tasks-list">Loading...</div>
  </div>

  <div class="form-section">
    <h2>Register Agent</h2>
    <div class="form-row">
      <input type="text" id="new-agent-id" placeholder="agent-id" style="width:120px">
      <input type="text" id="new-agent-name" placeholder="Display Name" style="width:160px">
      <input type="text" id="new-agent-pubkey" placeholder="Ed25519 pubkey (base64, optional)" style="flex:1">
      <button onclick="generateKeypair()" title="Generate Ed25519 keypair">keygen</button>
      <button class="primary" onclick="registerAgent()">Register</button>
    </div>
    <div id="key-output" class="key-output">
      <label>Public Key (will be registered):</label>
      <div class="key-val" id="gen-pubkey" onclick="copy(this.textContent)"></div>
      <label>Private Key (give to agent — shown once):</label>
      <div class="key-val" id="gen-privkey" onclick="copy(this.textContent)" style="color:#f87171"></div>
      <div class="warning">Copy the private key now. It cannot be recovered.</div>
    </div>
  </div>

  <footer>The Wire · agiterra · port ${process.env.WIRE_PORT ?? "9800"}</footer>

  <script>
    // --- Live SSE updates ---
    const evtSource = new EventSource('/dashboard/stream');
    evtSource.addEventListener('refresh', () => window.location.reload());
    evtSource.onmessage = (e) => {
      const agents = JSON.parse(e.data);

      // Update stats
      document.querySelector('.stats').innerHTML = [
        '<div><span class="stat-value">' + agents.length + '</span> agents</div>',
        '<div><span class="stat-value">' + agents.filter(a => a.online).length + '</span> online</div>',
        '<div><span class="stat-value">' + agents.reduce((n, a) => n + a.sessions, 0) + '</span> sessions</div>',
      ].join('');

      // Update table body
      const tbody = document.querySelector('tbody');
      tbody.innerHTML = agents.map(a => {
        const status = a.online ? '●' : '○';
        const statusColor = a.online ? '#4ade80' : '#6b7280';
        const planSnippet = a.plan ? a.plan.slice(0, 80) + (a.plan.length > 80 ? '…' : '') : '—';
        const lastSeen = a.last_seen_at ? new Date(a.last_seen_at).toLocaleString() : 'never';
        const pubkeyShort = a.pubkey ? a.pubkey.slice(0, 16) + '…' : '—';
        return '<tr>' +
          '<td><span style="color:' + statusColor + '">' + status + '</span></td>' +
          '<td class="agent-name copyable" data-copy="' + esc(a.id) + '" title="Click to copy">' + esc(a.id) + '</td>' +
          '<td>' + esc(a.display_name) + '</td>' +
          '<td class="copyable" data-copy="' + esc(a.pubkey) + '" title="Click to copy full pubkey">' + pubkeyShort + '</td>' +
          '<td>' + a.sessions + '</td>' +
          '<td class="plan">' + esc(planSnippet) + '</td>' +
          '<td class="dim">' + lastSeen + '</td>' +
          '</tr>';
      }).join('');

      // Re-bind click handlers via delegation
      tbody.querySelectorAll('[data-copy]').forEach(el => {
        el.onclick = () => copy(el.dataset.copy);
      });
    };

    // --- Message log ---
    evtSource.addEventListener('wire_message', (e) => {
      const msg = JSON.parse(e.data);
      const log = document.getElementById('message-log');
      const ts = new Date(msg.created_at).toLocaleTimeString();
      const deliveryBadges = (msg.deliveries || []).map(d =>
        '<span class="' + (d.delivered ? 'ok' : 'skip') + '">' + esc(d.agentId) + '</span>'
      ).join(' ');

      const entry = document.createElement('div');
      entry.className = 'msg-entry';
      entry.innerHTML =
        '<span class="msg-ts">' + ts + '</span>' +
        '<span class="msg-seq">#' + msg.seq + '</span>' +
        '<span class="msg-source">' + esc(msg.source || '') + '</span>' +
        '<span class="msg-arrow">\u2192</span>' +
        '<span class="msg-dest">' + esc(msg.dest || '*') + '</span>' +
        '<span class="msg-topic">' + esc(msg.topic || '') + '</span>' +
        '<span class="msg-delivery">' + deliveryBadges + '</span>';

      log.appendChild(entry);
      log.scrollTop = log.scrollHeight;

      // Cap at 100 entries
      while (log.children.length > 100) log.removeChild(log.firstChild);
    });

    function esc(s) {
      return s ? s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;') : '';
    }

    function copy(text) {
      navigator.clipboard.writeText(text).then(() => {
        // Brief flash
        const el = event?.target;
        if (el) {
          el.classList.add('copied');
          setTimeout(() => el.classList.remove('copied'), 600);
        }
      });
    }

    async function generateKeypair() {
      const kp = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
      const pubRaw = await crypto.subtle.exportKey('raw', kp.publicKey);
      const privRaw = await crypto.subtle.exportKey('pkcs8', kp.privateKey);
      const pubB64 = btoa(String.fromCharCode(...new Uint8Array(pubRaw)));
      const privB64 = btoa(String.fromCharCode(...new Uint8Array(privRaw)));

      document.getElementById('new-agent-pubkey').value = pubB64;
      document.getElementById('gen-pubkey').textContent = pubB64;
      document.getElementById('gen-privkey').textContent = privB64;
      document.getElementById('key-output').style.display = 'block';
    }

    // --- Tasks ---
    async function loadTasks() {
      try {
        const res = await fetch('/tasks');
        if (!res.ok) return;
        const data = await res.json();
        renderTasks(data);
      } catch {}
    }

    function renderTasks(data) {
      const el = document.getElementById('tasks-list');
      if (!data.tasks || !data.tasks.length) {
        el.innerHTML = '<span class="dim">No tasks</span>';
        return;
      }
      el.innerHTML = '<ol>' + data.tasks.map(t => {
        const statusLabel = (t.status || '').replace(/_/g, ' ');
        const statusClass = t.status || 'not_started';
        return '<li>' +
          '<div class="task-row" onclick="this.classList.toggle(\\'expanded\\')">' +
          '<span class="task-title">' + esc(t.title) + '</span>' +
          '<span class="task-owner">' + esc(t.owner || '') + '</span>' +
          '<span class="task-status ' + statusClass + '">' + esc(statusLabel) + '</span>' +
          '</div>' +
          '<div class="task-details">' + esc(t.details || '') + '</div>' +
          '</li>';
      }).join('') + '</ol>';
    }

    loadTasks();

    // Live task updates via SSE
    const taskStream = new EventSource('/tasks/stream');
    taskStream.onmessage = (e) => {
      try { renderTasks(JSON.parse(e.data)); } catch {}
    };

    async function registerAgent() {
      const id = document.getElementById('new-agent-id').value.trim();
      const name = document.getElementById('new-agent-name').value.trim();
      const pubkey = document.getElementById('new-agent-pubkey').value.trim();

      if (!id || !name) { alert('Agent ID and name are required'); return; }
      if (!pubkey) { alert('Public key required — use keygen or paste one'); return; }

      const res = await fetch('/agents/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, display_name: name, pubkey, subscriptions: [{ topic: '*' }] }),
      });

      if (res.ok) {
        window.location.reload();
      } else {
        const err = await res.json();
        alert('Registration failed: ' + (err.error || res.status));
      }
    }
  </script>
</body>
</html>`;
}

export function renderLogin(hasOwner: boolean): string {
  const action = hasOwner ? "Sign in" : "Claim this instance";
  const subtitle = hasOwner
    ? "Authenticate with your passkey to access the dashboard."
    : "No owner registered. The first passkey claims ownership.";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>The Wire — Login</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: #0a0a0a;
      color: #e5e5e5;
      font-family: 'SF Mono', 'Fira Code', 'JetBrains Mono', monospace;
      font-size: 13px;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
    }
    .card {
      background: #111;
      border: 1px solid #262626;
      border-radius: 8px;
      padding: 32px;
      width: 360px;
      text-align: center;
    }
    h1 { font-size: 16px; margin-bottom: 8px; }
    p { color: #6b7280; margin-bottom: 24px; font-size: 12px; }
    button {
      background: #fafafa;
      color: #0a0a0a;
      border: none;
      padding: 10px 24px;
      font-family: inherit;
      font-size: 13px;
      font-weight: 600;
      border-radius: 4px;
      cursor: pointer;
      width: 100%;
    }
    button:hover { background: #d4d4d8; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    .error { color: #f87171; margin-top: 12px; font-size: 12px; display: none; }
    #name-field { display: ${hasOwner ? "none" : "block"}; margin-bottom: 16px; }
    input {
      background: #1a1a1a;
      border: 1px solid #333;
      color: #e5e5e5;
      padding: 8px 12px;
      font-family: inherit;
      font-size: 13px;
      border-radius: 4px;
      width: 100%;
    }
    input:focus { outline: none; border-color: #60a5fa; }
  </style>
</head>
<body>
  <div class="card">
    <h1>The Wire</h1>
    <p>${subtitle}</p>
    <div id="name-field">
      <input type="text" id="display-name" placeholder="Your name" autocomplete="name">
    </div>
    <button id="auth-btn" onclick="authenticate()">${action}</button>
    <div id="error" class="error"></div>
  </div>

  <script>
    const hasOwner = ${hasOwner};

    async function authenticate() {
      const btn = document.getElementById('auth-btn');
      const errEl = document.getElementById('error');
      btn.disabled = true;
      errEl.style.display = 'none';

      try {
        if (!hasOwner) {
          await doRegister();
        } else {
          await doLogin();
        }
      } catch (e) {
        errEl.textContent = e.message || 'Authentication failed';
        errEl.style.display = 'block';
        btn.disabled = false;
      }
    }

    async function doRegister() {
      const name = document.getElementById('display-name').value || 'Operator';
      const res = await fetch('/auth/register/options', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ display_name: name }),
      });
      const options = await res.json();

      // Decode challenge
      options.challenge = base64urlToBuffer(options.challenge);
      options.user.id = base64urlToBuffer(options.user.id);

      const credential = await navigator.credentials.create({ publicKey: options });
      const response = credential.response;

      await fetch('/auth/register/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: credential.id,
          rawId: bufferToBase64url(credential.rawId),
          response: {
            clientDataJSON: bufferToBase64url(response.clientDataJSON),
            attestationObject: bufferToBase64url(response.attestationObject),
          },
          type: credential.type,
          display_name: name,
          challenge: options._challenge,
        }),
      });

      window.location.reload();
    }

    async function doLogin() {
      const res = await fetch('/auth/login/options', { method: 'POST' });
      const options = await res.json();
      const savedChallenge = options.challenge;

      const publicKeyOptions = {
        challenge: base64urlToBuffer(options.challenge),
        rpId: options.rpId,
        timeout: options.timeout,
        userVerification: options.userVerification,
      };

      const credential = await navigator.credentials.get({ publicKey: publicKeyOptions });
      const response = credential.response;

      const verifyRes = await fetch('/auth/login/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: credential.id,
          rawId: bufferToBase64url(credential.rawId),
          response: {
            clientDataJSON: bufferToBase64url(response.clientDataJSON),
            authenticatorData: bufferToBase64url(response.authenticatorData),
            signature: bufferToBase64url(response.signature),
          },
          type: credential.type,
          challenge: savedChallenge,
        }),
      });

      if (verifyRes.ok) {
        window.location.reload();
      } else {
        throw new Error('Login verification failed');
      }
    }

    function base64urlToBuffer(b64url) {
      const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
      const bin = atob(b64);
      return Uint8Array.from(bin, c => c.charCodeAt(0)).buffer;
    }

    function bufferToBase64url(buf) {
      const bytes = new Uint8Array(buf);
      let str = '';
      for (const b of bytes) str += String.fromCharCode(b);
      return btoa(str).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
    }
  </script>
</body>
</html>`;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

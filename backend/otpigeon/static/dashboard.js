'use strict';
const $ = (s) => document.querySelector(s);
const state = {csrf: '', projects: [], project: null, environment: 'test', view: 'overview', cursor: null, page: 0};
const titles = {overview: 'Overview', challenges: 'Challenges', keys: 'API keys', provider: 'Delivery provider', integration: 'Integration'};
const el = (tag, text, className) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (className) n.className = className; return n; };
function notice(message) { $('#notice').textContent = message; $('#notice').hidden = false; clearTimeout(notice.timer); notice.timer = setTimeout(() => { $('#notice').hidden = true; }, 8000); }
async function api(path, {method = 'GET', body} = {}) {
  const response = await fetch('/admin' + path, {method, credentials: 'same-origin', headers: {'Content-Type': 'application/json', 'X-CSRF-Token': state.csrf}, ...(body !== undefined ? {body: JSON.stringify(body)} : {})});
  const data = await response.json();
  if (!response.ok) { if (response.status === 401 && path !== '/login') showLogin(); throw new Error(data.error?.message || 'Request failed. Please try again.'); }
  return data;
}
function button(label, action, className = 'secondary') { const b = el('button', label, className); b.type = 'button'; b.addEventListener('click', async () => { b.disabled = true; try { await action(); } catch (e) { notice(e.message); } finally { b.disabled = false; } }); return b; }
function panel(title, description) { const box = el('section', undefined, 'panel'); box.append(el('h2', title)); if (description) box.append(el('p', description, 'muted')); return box; }
function field(form, label, name, {type = 'text', value = '', required = true, placeholder = ''} = {}) { const wrap = el('div', undefined, 'field'); const id = 'field-' + name; const l = el('label', label); l.htmlFor = id; const input = el('input'); Object.assign(input, {id, name, type, value, required, placeholder}); input.autocomplete = type === 'password' ? 'new-password' : 'off'; wrap.append(l, input); form.append(wrap); return input; }
function submit(form, label, action) { const b = el('button', label, 'primary'); b.type = 'submit'; form.append(b); form.addEventListener('submit', async (event) => { event.preventDefault(); b.disabled = true; try { await action(new FormData(form)); } catch (e) { notice(e.message); } finally { b.disabled = false; } }); }
function openModal(title, content) { $('#modal-title').textContent = title; $('#modal-body').replaceChildren(content); $('#modal').showModal(); }
function closeModal() { $('#modal').close(); $('#modal-body').replaceChildren(); }
$('#close-modal').addEventListener('click', closeModal);
$('#modal').addEventListener('close', () => $('#modal-body').replaceChildren());
function showLogin() { state.csrf = ''; $('#application').hidden = true; $('#login').hidden = false; }
function time(value) { return value ? new Date(value).toLocaleString() : '—'; }
function badge(value) { return el('span', String(value || 'unknown').replaceAll('_', ' '), 'badge ' + value); }
function scoped(suffix) { return '/projects/' + encodeURIComponent(state.project.project_id) + suffix; }
function envQuery() { return '?environment=' + state.environment; }
function codeBlock(text) { const pre = el('pre'); pre.append(el('code', text)); return pre; }
function table(headers, rows) { const wrap = el('div', undefined, 'table-wrap'); const t = el('table'); const head = el('thead'); const tr = el('tr'); for (const h of headers) { const th = el('th', h); th.scope = 'col'; tr.append(th); } head.append(tr); const body = el('tbody'); for (const row of rows) { const r = el('tr'); for (const v of row) { const td = el('td'); td.append(v instanceof Node ? v : document.createTextNode(String(v))); r.append(td); } body.append(r); } t.append(head, body); wrap.append(t); return wrap; }
async function loadProjects(selected) { const data = await api('/projects'); state.projects = data.items; state.project = data.items.find(p => p.project_id === (selected || state.project?.project_id)) || data.items[0] || null; $('#project').replaceChildren(); for (const p of data.items) { const option = el('option', p.name); option.value = p.project_id; $('#project').append(option); } if (state.project) $('#project').value = state.project.project_id; }
async function enter() { $('#operator-token').value = ''; $('#login').hidden = true; $('#application').hidden = false; await loadProjects(); await render(); }
$('#login-form').addEventListener('submit', async event => { event.preventDefault(); const b = event.submitter; b.disabled = true; try { const data = await api('/login', {method: 'POST', body: {token: $('#operator-token').value}}); state.csrf = data.csrf_token; await enter(); } catch (e) { notice(e.message); } finally { $('#operator-token').value = ''; b.disabled = false; } });
$('#logout').addEventListener('click', async () => { try { await api('/logout', {method: 'POST'}); closeModal(); showLogin(); } catch (e) { notice(e.message); } });
$('#new-project').addEventListener('click', () => { const form = el('form', undefined, 'stack'); field(form, 'Application name', 'name'); submit(form, 'Create project', async values => { const p = await api('/projects', {method: 'POST', body: {name: values.get('name')}}); await loadProjects(p.project_id); closeModal(); await render(); notice('Project created. Issue a test key to start integrating.'); }); openModal('Create a project', form); });
$('#project').addEventListener('change', async () => { state.project = state.projects.find(p => p.project_id === $('#project').value); state.cursor = null; await render(); });
$('#environment').addEventListener('change', async () => { state.environment = $('#environment').value; state.cursor = null; await render(); });
$('#refresh').addEventListener('click', async () => { try { await loadProjects(); await render(); } catch (e) { notice(e.message); } });
for (const nav of document.querySelectorAll('[data-view]')) nav.addEventListener('click', () => { state.view = nav.dataset.view; state.cursor = null; render(); });
async function render() {
  const page = ++state.page;
  $('#view-title').textContent = titles[state.view]; $('#project-name').textContent = state.project?.name || 'Your installation';
  for (const n of document.querySelectorAll('[data-view]')) { if (n.dataset.view === state.view) n.setAttribute('aria-current', 'page'); else n.removeAttribute('aria-current'); }
  const view = $('#view'); view.replaceChildren(el('p', 'Loading workspace…', 'muted')); view.setAttribute('aria-busy', 'true');
  try {
    const status = await api('/status'); if (page !== state.page) return;
    $('#installation-status').textContent = `${status.workers} active worker${status.workers === 1 ? '' : 's'} · ${status.queued} queued · ${status.unknown} unknown outcomes · Live delivery ${status.live_enabled ? 'enabled' : 'disabled'}`;
    if (!state.project) { const box = panel('Start with your first application', 'Each project owns its provider configuration, test and live keys, and verification history.'); box.append(button('Create a project', () => $('#new-project').click(), 'primary')); view.replaceChildren(box); return; }
    const content = await ({overview, challenges, keys, provider, integration}[state.view])();
    if (page === state.page) view.replaceChildren(...content);
  } catch (e) { if (page === state.page) { const box = panel('Could not load this view', e.message); box.append(button('Try again', render)); view.replaceChildren(box); } }
  finally { if (page === state.page) view.removeAttribute('aria-busy'); }
}
async function overview() {
  const data = await api(scoped('/metrics') + envQuery()); const grid = el('div', undefined, 'metrics');
  for (const [label, key] of [['Requested', 'requested'], ['Verified', 'verified'], ['Delivered', 'delivered'], ['Delivery failed', 'failed']]) { const m = el('div', undefined, 'metric'); m.append(el('span', label), el('strong', data[key] ?? 0)); grid.append(m); }
  const flow = panel('Every verification has a story', `${data.pending} pending · ${data.expired} expired · ${data.locked} locked. Provider acceptance and confirmed delivery are tracked separately from successful verification.`);
  flow.append(button('View challenges', async () => { state.view = 'challenges'; await render(); }));
  const box = panel(state.environment === 'test' ? 'Try the complete flow' : 'Ready for live delivery?', state.environment === 'test' ? 'Send a simulated code, retrieve it from the test outbox, and verify it here. No message leaves this installation.' : 'Configure your provider, enable live delivery on the server, and use a live API key from your backend.');
  if (state.environment === 'test') {
    const form = el('form', undefined, 'form-grid'); field(form, 'Phone number (E.164)', 'destination', {value: '+15555550123'}); field(form, 'Purpose', 'purpose', {value: 'signup'});
    submit(form, 'Request test code', async values => { const c = await api(scoped('/test-challenges'), {method: 'POST', body: Object.fromEntries(values)}); await testChallenge(c); }); box.append(form);
  } else box.append(button('Configure provider', async () => { state.view = 'provider'; await render(); }));
  return [grid, flow, box];
}
async function testChallenge(challenge) {
  const box = el('div', undefined, 'stack'); box.append(el('p', 'Challenge ' + challenge.challenge_id, 'mono'), el('p', 'The worker must process the simulated job before its code appears.'));
  const result = el('p', 'Waiting for simulated delivery…', 'hint'); box.append(result);
  const form = el('form', undefined, 'stack'); const input = field(form, 'Verification code', 'code', {placeholder: '6-digit code'}); input.inputMode = 'numeric'; input.pattern = '[0-9]{6}'; input.maxLength = 6;
  submit(form, 'Verify code', async values => { const v = await api(scoped('/test-challenges/') + encodeURIComponent(challenge.challenge_id) + '/verify', {method: 'POST', body: {code: values.get('code')}}); result.textContent = v.verified ? 'Verified. This challenge has been consumed.' : 'Verification was not completed.'; form.remove(); notice('Test flow completed.'); });
  box.append(button('Retrieve test code', async () => { const out = await api(scoped('/test-challenges/') + encodeURIComponent(challenge.challenge_id) + '/code'); input.value = out.code; result.textContent = 'Simulated delivery received. This outbox exists only for test challenges.'; }), form);
  openModal('Test verification', box);
  try { const out = await api(scoped('/test-challenges/') + encodeURIComponent(challenge.challenge_id) + '/code'); input.value = out.code; result.textContent = 'Simulated delivery received.'; } catch { result.textContent = 'Queued. Select “Retrieve test code” after the worker processes it.'; }
}
async function challenges() {
  const data = await api(scoped('/challenges') + envQuery() + (state.cursor ? '&before=' + encodeURIComponent(state.cursor) : ''));
  const box = panel('Verification activity', 'Open a challenge to see delivery outcomes, reasons, generations, and event timings.');
  if (!data.items.length) box.append(el('p', 'No challenges yet in this environment.', 'empty'));
  else box.append(table(['Destination / purpose', 'Created', 'Verification', 'Delivery', ''], data.items.map(c => [el('span', `${c.destination ? '***' + c.destination.slice(-4) : '—'} · ${c.purpose}`), time(c.created_at), badge(c.status), badge(c.delivery.status), button('Details', () => details(c))])));
  const pager = el('div', undefined, 'toolbar'); if (state.cursor) pager.append(button('Newest', async () => { state.cursor = null; await render(); })); if (data.next_cursor) pager.append(button('Older', async () => { state.cursor = data.next_cursor; await render(); })); box.append(pager); return [box];
}
async function details(challenge) {
  const data = await api(scoped('/events') + envQuery() + '&challenge_id=' + encodeURIComponent(challenge.challenge_id)); const box = el('div', undefined, 'stack');
  box.append(el('p', challenge.challenge_id, 'mono'), el('p', `${challenge.destination ? '***' + challenge.destination.slice(-4) : ''} · ${challenge.purpose}`), el('p', 'Expires ' + time(challenge.expires_at)), badge(challenge.status), el('p', 'Delivery: ' + challenge.delivery.status + (challenge.delivery.reason ? ' · ' + challenge.delivery.reason : '')));
  const timeline = el('ol', undefined, 'timeline'); for (const e of data.items) { const item = el('li'); item.append(el('strong', e.type.replaceAll('_', ' ')), el('span', `${time(e.timestamp)} · generation ${e.generation || 'initial'}${e.reason ? ' · ' + e.reason : ''}`, 'muted')); timeline.append(item); } box.append(timeline); if (data.next_cursor) box.append(el('p', 'More events are available through the paginated API.', 'hint')); openModal('Challenge timeline', box);
}
async function keys() {
  const data = await api(scoped('/keys')); const box = panel('Application API keys', 'Keep keys on your application backend. Test and live keys cannot access each other’s challenges.');
  box.append(button('Issue ' + state.environment + ' key', async () => { const issued = await api(scoped('/keys'), {method: 'POST', body: {environment: state.environment}}); const content = el('div', undefined, 'stack'); content.append(el('p', 'Copy this key now. It is shown once and cannot be retrieved later.')); const input = field(content, 'New API key', 'issued-key', {type: 'password', value: issued.api_key}); input.readOnly = true; content.append(button('Show / hide key', () => { input.type = input.type === 'password' ? 'text' : 'password'; }), button('Copy key', async () => { await navigator.clipboard.writeText(input.value); notice('Key copied.'); })); openModal('Save your API key', content); await render(); }, 'primary'));
  const rows = data.items.filter(k => k.environment === state.environment);
  if (!rows.length) box.append(el('p', 'No keys in this environment.', 'empty'));
  else box.append(table(['Key prefix', 'Created', 'Status', ''], rows.map(k => [el('code', k.prefix + '…'), time(k.created_at), k.revoked_at ? 'Revoked' : 'Active', k.revoked_at ? '—' : button('Revoke', async () => { const content = el('div', undefined, 'stack'); content.append(el('p', 'Applications using this key will lose access immediately. Queued sends using it will be canceled before dispatch.'), button('Revoke key', async () => { await api('/keys/' + encodeURIComponent(k.key_id), {method: 'DELETE'}); closeModal(); await render(); notice('Key revoked.'); }, 'danger')); openModal('Revoke this key?', content); })])));
  return [box];
}
async function provider() {
  const current = state.project.environments.live;
  const box = panel('Project delivery provider', 'The test environment always uses simulated delivery. Live credentials are encrypted in storage and never returned to this dashboard. Saving replaces the entire configuration and invalidates older queued jobs.');
  box.append(el('p', 'Current live provider: ' + (current.provider || 'Not configured')));
  const label = el('label', 'Provider'); label.htmlFor = 'provider-type'; const choice = el('select'); choice.id = 'provider-type'; for (const [value, text] of [['twilio_sms', 'Twilio · SMS'], ['meta_whatsapp', 'Meta · WhatsApp Cloud API']]) { const o = el('option', text); o.value = value; choice.append(o); } if (current.provider) choice.value = current.provider;
  const container = el('div'); const fields = () => {
    const form = el('form', undefined, 'form-grid');
    if (choice.value === 'twilio_sms') { field(form, 'Account SID', 'account_sid', {placeholder: 'AC…'}); field(form, 'Auth token', 'auth_token', {type: 'password'}); field(form, 'Sender phone number', 'from_number', {placeholder: '+15555550123'}); }
    else { field(form, 'Phone number ID', 'phone_number_id'); field(form, 'Graph API version', 'api_version', {placeholder: 'Your supported version, e.g. v23.0'}); field(form, 'Access token', 'access_token', {type: 'password'}); field(form, 'App secret', 'app_secret', {type: 'password'}); field(form, 'Webhook verify token', 'verify_token', {type: 'password'}); field(form, 'Authentication template name', 'template_name', {value: current.settings?.template_name || ''}); field(form, 'Template language', 'language', {value: current.settings?.language || 'en_US'}); }
    submit(form, 'Save live configuration', async values => { await api(scoped('/provider'), {method: 'POST', body: {provider: choice.value, ...Object.fromEntries(values)}}); form.reset(); await loadProjects(); await render(); notice('Provider saved. Live delivery also requires the server opt-in.'); }); container.replaceChildren(form);
  }; choice.addEventListener('change', fields); fields(); box.append(label, choice, container);
  if (current.provider) box.append(button('Disable provider', async () => { const content = el('div', undefined, 'stack'); content.append(el('p', 'New live sends will be blocked and queued sends invalidated. In-flight sends may still complete.'), button('Disable live provider', async () => { await api(scoped('/provider'), {method: 'DELETE'}); closeModal(); await loadProjects(); await render(); }, 'danger')); openModal('Disable delivery?', content); }, 'danger'));
  const hooks = panel('Delivery receipts', 'Twilio callbacks are attached automatically to each send. For Meta, configure this callback URL and your verify token in the Meta app. Subscribe to the messages webhook.'); hooks.append(codeBlock(location.origin + '/webhooks/meta/' + state.project.project_id)); return [box, hooks];
}
async function integration() {
  const box = panel('Connect your backend', 'Your application owns accounts and login sessions. OTPigeon returns a single-use verification result for a project, environment, phone number, and purpose.');
  box.append(codeBlock(`import { OTPigeon } from 'otpigeon-sdk';\n\nconst gateway = new OTPigeon({\n  baseUrl: '${location.origin}',\n  apiKey: process.env.OTPIGEON_API_KEY,\n});\nconst challenge = await gateway.create({\n  destination: '+15555550123', purpose: 'signup',\n});\n// Store challenge.challenge_id in your server-side login flow.\nconst result = await gateway.verify(challenge.challenge_id, userCode);\nif (result.verified) { /* establish your application's session */ }`));
  box.append(el('p', 'Use a stable idempotencyKey when retrying a create or resend after a network failure. The SDK does not retry mutations automatically.', 'hint'), el('a', 'Browse the interactive API'));
  box.lastChild.href = '/docs'; return [box];
}
(async () => { try { state.csrf = (await api('/session')).csrf_token; await enter(); } catch { showLogin(); } })();

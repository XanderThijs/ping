(() => {
  const $ = id => document.getElementById(id);
  const el = (t, c, x) => { const e = document.createElement(t); if (c) e.className = c; if (x != null) e.textContent = x; return e; };
  const ago = iso => { const s = Math.max(0, (Date.now() - new Date(iso)) / 1000); if (s < 90) return Math.round(s) + ' seconds ago'; if (s < 5400) return Math.round(s / 60) + ' minutes ago'; if (s < 129600) return Math.round(s / 3600) + ' hours ago'; return Math.round(s / 86400) + ' days ago'; };
  const dur = ms => { const m = Math.round(ms / 60000); return m < 1 ? 'under a minute' : m < 90 ? m + ' min' : m < 2880 ? Math.round(m / 60) + ' h' : Math.round(m / 1440) + ' days'; };
  const when = t => new Date(t).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const size = b => b > 1e9 ? (b / 1e9).toFixed(1) + ' GB' : b > 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1e3)) + ' KB';
  const row = (k, v, cls) => { const r = el('div', 'row'); r.append(el('span', '', k), el('span', cls || '', v)); return r; };

  async function load() {
    let s; try { const r = await fetch('api/state', { cache: 'no-store' }); if (!r.ok) throw 0; s = await r.json(); } catch { $('head').textContent = 'Cannot reach Ping'; return; }
    $('who').textContent = 'Checked ' + (s.checked ? ago(s.checked) : 'never');
    const down = s.services.filter(x => x.up === false).length, hasP = s.problems > 0;
    document.documentElement.style.setProperty('--sc', hasP ? (down ? 'var(--b)' : 'var(--w)') : 'var(--g)');
    $('head').textContent = !s.checked ? 'Waiting for the first check' : hasP ? (down ? down + ' service' + (down > 1 ? 's' : '') + ' down' : 'Needs attention') : 'Everything is running';
    $('sub').textContent = [s.services.filter(x => x.up).length + ' of ' + s.services.length + ' services up', s.disk ? 'disk ' + s.disk.usedPercent + '%' : null,
      s.backups.volumes[0] ? 'last backup ' + ago(s.backups.volumes.map(v => v.latest.at).sort().pop()) : 'no backups'].filter(Boolean).join(' · ');

    const sv = $('svc'); sv.replaceChildren();
    for (const a of s.services) {
      const r = el('div', 'svc'), n = el('div', 'nm'), b = el('b'); b.append(el('i', 'led ' + (a.up === false ? 'd' : a.up ? '' : 'u')), document.createTextNode(a.name));
      n.append(b, el('small', '', a.up === false ? (a.err || 'down') : a.path));
      const bars = el('div', 'bars'); bars.setAttribute('role', 'img'); bars.setAttribute('aria-label', a.name + ' availability, last 60 days');
      a.days.forEach(v => { const x = el('s', v == null ? 'na' : v >= 99.5 ? '' : v >= 90 ? 'w' : 'b'); x.title = v == null ? 'No data' : v + '%'; bars.appendChild(x); });
      const rt = el('div', 'r'); rt.append(el('b', '', a.uptime == null ? '–' : a.uptime + '%'), document.createElement('br'), document.createTextNode(a.ms == null ? '–' : a.ms + ' ms'));
      r.append(n, bars, rt); sv.appendChild(r);
    }

    const inc = $('inc'); inc.replaceChildren();
    if (!s.incidents.length) inc.appendChild(el('div', 'empty', 'No incidents yet.'));
    else { const t = el('table'), h = el('tr'); ['When', 'What', 'Lasted', ''].forEach(x => h.appendChild(el('th', '', x))); t.appendChild(h);
      for (const i of s.incidents) { const tr = el('tr'); const pill = el('span', 'pill ' + (i.end ? 'r1' : 'o'), i.end ? 'Resolved' : 'Ongoing'); const last = el('td'); last.appendChild(pill);
        tr.append(el('td', '', when(i.start)), el('td', '', i.what), el('td', '', dur((i.end || Date.now()) - i.start)), last); t.appendChild(tr); } inc.appendChild(t); }

    const d = $('disk'); d.replaceChildren();
    if (s.disk) { const big = el('div', 'big', s.disk.usedPercent + '%'); big.appendChild(el('small', '', ' used'));
      const m = el('div', 'meter'), i = el('i', s.disk.usedPercent >= s.disk.alertAt ? 'hot' : ''); i.style.width = s.disk.usedPercent + '%'; m.appendChild(i);
      d.append(big, m, el('div', 'mu', s.disk.freeGB + ' GB free of ' + s.disk.totalGB + ' GB · alert at ' + s.disk.alertAt + '%')); }
    else d.appendChild(el('div', 'empty', 'Disk size not available.'));

    const bk = $('bk'); bk.replaceChildren(); $('bkNote').textContent = 'alert after ' + s.backups.maxHours + ' hours';
    if (s.backups.error || !s.backups.volumes.length) bk.appendChild(el('div', 'empty bad', s.backups.error || 'No backups found.'));
    for (const v of s.backups.volumes) { const stale = Date.now() - new Date(v.latest.at) > s.backups.maxHours * 3600e3;
      bk.append(row(v.name.replace(/^.*?_/, ''), ago(v.latest.at) + ' · ' + size(v.latest.size), stale || !v.latest.ok ? 'bad' : 'ok'),
        row('Archive check', v.latest.ok ? 'Readable, not empty' : 'Empty or unreadable', v.latest.ok ? 'ok' : 'bad'), row('Kept', String(v.kept))); }

    const al = $('al'); al.replaceChildren(); $('alNote').textContent = s.alerts.configured ? 'to your phone' : 'not set up';
    if (s.alerts.configured) { const f = el('div', 'field'); f.append(el('span', '', 'ntfy topic'), el('div', '', s.alerts.topic)); const g = el('div', 'field'); g.append(el('span', '', 'Alert me when'), el('div', '', 'A service fails ' + s.alerts.failsBeforeAlert + ' checks in a row · disk above ' + s.alerts.diskAlert + '% · a backup is missing, old or unreadable')); al.append(f, g); }
    else al.appendChild(el('div', 'empty', 'Set NTFY_URL in the .env file to get alerts on your phone.'));
  }
  $('test').addEventListener('click', async e => { const b = e.target; b.disabled = true; b.textContent = 'Sending…';
    try { const r = await (await fetch('api/test', { method: 'POST' })).json(); b.textContent = r.sent ? 'Sent' : r.configured ? 'Could not send' : 'Alerts not set up'; } catch { b.textContent = 'Could not send'; }
    setTimeout(() => { b.disabled = false; b.textContent = 'Send test alert'; }, 2500); });
  load(); setInterval(load, 20000);
})();

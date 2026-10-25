// supabase-claude.js
// Stands in for claude.ai's `window.claude` so the app runs on its own website,
// with its data in Supabase.
//
// The app asks for features with `window.claude.use(name)`:
//   'db'        -> collections of documents (one `docs` table in Supabase)
//   'assets'    -> uploading invoices and photos (the private `attachments` bucket)
//   'downloads' -> saving a file to the device
//   'sample'    -> photo reading; not available yet, so the app hides Snap to log
//
// Nothing is answered until you are signed in, so the app simply shows
// "Loading…" behind the sign-in screen and starts once you are in.
// Needs supabase-js and config.js loaded first.

(function () {
  const cfg = window.PRADO_CONFIG || {};
  const sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey, {
    auth: { persistSession: true, storageKey: 'prado-auth' }
  });
  const BUCKET = 'attachments';
  const newId = () => (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '') : Math.random().toString(36).slice(2) + Date.now().toString(36));

  // Turns a Supabase error into the { code } shape the app's messages expect.
  function fail(err, fallback) {
    const msg = (err && err.message) || '';
    const status = err && (err.status || err.statusCode);
    let code = fallback || 'unavailable';
    if ((err && err.code === '42501') || status === 401 || status === 403 || /row-level security|permission|jwt/i.test(msg)) code = 'invalid_argument';
    else if (status === 413 || /too large|exceeded the maximum/i.test(msg)) code = 'too_large';
    else if (/mime|content type/i.test(msg)) code = 'unsupported_type';
    const e = new Error(msg || code);
    e.code = code;
    e.cause = err;
    return e;
  }

  /* ---------- Signing in ---------- */

  let userId = null;
  let resolveReady;
  const ready = new Promise(r => { resolveReady = r; });

  function signedIn(session) {
    userId = session.user.id;
    const box = document.getElementById('prado-signin');
    if (box) box.remove();
    addSignOut();
    resolveReady();
  }

  function addSignOut() {
    if (document.getElementById('prado-signout')) return;
    const p = document.createElement('p');
    p.id = 'prado-signout';
    p.innerHTML = '<button type="button">Sign out</button>';
    p.querySelector('button').onclick = async () => { await sb.auth.signOut(); location.reload(); };
    document.body.appendChild(p);
  }

  function showSignIn() {
    const box = document.createElement('div');
    box.id = 'prado-signin';
    box.innerHTML = `<form novalidate>
        <h1>Prado Service Tracker</h1>
        <p class="sub">Sign in to see your service records.</p>
        <label for="ps-email">Email</label>
        <input id="ps-email" type="email" autocomplete="username" inputmode="email" autocapitalize="none" spellcheck="false" required>
        <label for="ps-pass">Password</label>
        <input id="ps-pass" type="password" autocomplete="current-password" required>
        <p class="err" role="alert" hidden></p>
        <button type="submit">Sign in</button>
      </form>`;
    document.body.appendChild(box);
    const form = box.querySelector('form'), btn = form.querySelector('button'), err = form.querySelector('.err');
    form.onsubmit = async (e) => {
      e.preventDefault();
      err.hidden = true; btn.disabled = true; btn.textContent = 'Signing in…';
      const { data, error } = await sb.auth.signInWithPassword({ email: form.querySelector('#ps-email').value.trim(), password: form.querySelector('#ps-pass').value });
      btn.disabled = false; btn.textContent = 'Sign in';
      if (error) {
        err.textContent = /invalid login/i.test(error.message) ? 'That email and password don’t match.' : /fetch|network/i.test(error.message) ? 'Couldn’t reach the server. Check your connection.' : error.message;
        err.hidden = false;
        return;
      }
      signedIn(data.session);
    };
    setTimeout(() => form.querySelector('#ps-email').focus(), 0);
  }

  const style = document.createElement('style');
  style.textContent = `
    #prado-signin { position: fixed; inset: 0; z-index: 1000; display: grid; place-items: center; padding: 16px; background: var(--bg, #efefed); color: var(--fg, #16181a); font-family: Barlow, system-ui, sans-serif; }
    #prado-signin form { width: 100%; max-width: 360px; display: grid; gap: 8px; background: var(--surface, #fff); border: 1px solid var(--line, #d6d8da); border-top: 4px solid var(--accent, #d10f1e); border-radius: 12px; padding: 22px 20px; }
    #prado-signin h1 { margin: 0; font: 800 26px/1.1 'Barlow Condensed', 'Arial Narrow', sans-serif; text-transform: uppercase; letter-spacing: .02em; }
    #prado-signin .sub { margin: 0 0 8px; color: var(--muted, #5d6166); }
    #prado-signin label { font: 700 13px 'Barlow Condensed', 'Arial Narrow', sans-serif; text-transform: uppercase; letter-spacing: .06em; color: var(--muted, #5d6166); margin-top: 4px; }
    #prado-signin input { font: inherit; font-size: 16px; padding: 11px 12px; border: 1px solid var(--line, #d6d8da); border-radius: 8px; background: var(--surface, #fff); color: var(--fg, #16181a); }
    #prado-signin input:focus { outline: 2px solid var(--accent, #d10f1e); outline-offset: 1px; }
    #prado-signin .err { margin: 4px 0 0; color: var(--over, #8f1d1d); font-weight: 600; }
    #prado-signin button { margin-top: 10px; font: 700 17px 'Barlow Condensed', 'Arial Narrow', sans-serif; text-transform: uppercase; letter-spacing: .06em; padding: 12px; border: 0; border-radius: 8px; background: var(--accent, #d10f1e); color: var(--accent-fg, #fff); cursor: pointer; }
    #prado-signin button:disabled { opacity: .6; cursor: default; }
    #prado-signout { text-align: center; margin: 8px 0 28px; }
    #prado-signout button { font: 500 13px Barlow, system-ui, sans-serif; color: var(--muted, #5d6166); background: none; border: 0; padding: 8px; text-decoration: underline; cursor: pointer; }
  `;
  document.head.appendChild(style);

  // Start once the page has loaded: either carry on a saved session or ask to sign in.
  document.addEventListener('DOMContentLoaded', async () => {
    const { data } = await sb.auth.getSession();
    if (data.session) signedIn(data.session); else showSignIn();
  });

  /* ---------- Database ---------- */

  // One live connection for the whole table. Each change says which collection
  // it belongs to (deletes carry only the key, which includes the collection),
  // and that collection is loaded again for everyone listening to it.
  const listeners = {}; // collection -> Set of { next, onError }
  let channel = null;

  async function load(col) {
    const { data, error } = await sb.from('docs').select('id, data').eq('collection', col).order('id');
    if (error) throw fail(error);
    const docs = data.map(r => ({ id: r.id, exists: true, data: () => r.data || {} }));
    return { docs, size: docs.length, empty: docs.length === 0 };
  }

  const pending = {};
  function refresh(col) {
    if (!listeners[col] || !listeners[col].size) return;
    clearTimeout(pending[col]);
    pending[col] = setTimeout(async () => {
      try { const snap = await load(col); listeners[col].forEach(l => l.next(snap)); }
      catch (e) { listeners[col].forEach(l => l.onError && l.onError(e)); }
    }, 120);
  }

  function ensureChannel() {
    if (channel) return;
    channel = sb.channel('docs-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'docs' }, (p) => {
        const row = p.new && p.new.collection ? p.new : p.old;
        if (row && row.collection) refresh(row.collection);
      })
      .subscribe();
  }

  function collection(col) {
    return {
      onSnapshot(next, onError) {
        const l = { next, onError };
        (listeners[col] = listeners[col] || new Set()).add(l);
        ensureChannel();
        load(col).then(next, (e) => onError && onError(e));
        return () => { listeners[col].delete(l); };
      },
      doc(id) {
        const docId = id || newId();
        return {
          id: docId,
          async set(data) {
            const { error } = await sb.from('docs').upsert({ owner: userId, collection: col, id: docId, data }, { onConflict: 'owner,collection,id' });
            if (error) throw fail(error);
            refresh(col); // show it straight away, without waiting for the live update
          },
          async delete() {
            const { error } = await sb.from('docs').delete().eq('collection', col).eq('id', docId);
            if (error) throw fail(error);
            refresh(col);
          }
        };
      },
      async add(data) {
        const ref = this.doc();
        await ref.set(data);
        return ref;
      }
    };
  }

  /* ---------- Files ---------- */

  // Files are stored as <user id>/<id>, or <user id>/<id>.pdf for ones moved from claude.ai.
  const paths = {};
  async function pathFor(id) {
    if (paths[id]) return paths[id];
    const { data, error } = await sb.storage.from(BUCKET).list(userId, { search: id, limit: 10 });
    if (error) throw fail(error);
    const hit = (data || []).find(f => f.name === id || f.name.startsWith(id + '.'));
    if (!hit) throw fail(null, 'not_found');
    return (paths[id] = `${userId}/${hit.name}`);
  }

  const MAX_BYTES = 20 * 1024 * 1024;
  const TYPES = /^(image\/(png|jpeg|gif|webp)|application\/pdf)$/;
  const assets = {
    async upload(file) {
      if (file.size > MAX_BYTES) throw fail(null, 'too_large');
      if (!TYPES.test(file.type)) throw fail(null, 'unsupported_type');
      const id = newId();
      const path = `${userId}/${id}`;
      const { error } = await sb.storage.from(BUCKET).upload(path, file, { contentType: file.type, upsert: false });
      if (error) throw fail(error);
      paths[id] = path;
      return { id, contentType: file.type, sizeBytes: file.size };
    }
  };

  // A link to a stored file that works for 15 minutes. Used where the app shows attachments.
  window.pradoFileUrl = async function (id) {
    await ready;
    const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(await pathFor(id), 15 * 60);
    if (error) throw fail(error);
    return data.signedUrl;
  };

  /* ---------- Downloads ---------- */

  const TYPE_BY_EXT = { json: 'application/json', csv: 'text/csv', pdf: 'application/pdf', txt: 'text/plain' };
  const downloads = {
    async save({ filename, data }) {
      const ext = String(filename).split('.').pop().toLowerCase();
      const blob = data instanceof Blob ? data : new Blob([data], { type: (TYPE_BY_EXT[ext] || 'application/octet-stream') + ';charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    }
  };

  /* ---------- window.claude ---------- */

  window.claude = {
    async use(name) {
      await ready;
      if (name === 'db') return { collection };
      if (name === 'assets') return assets;
      if (name === 'downloads') return downloads;
      return null; // 'sample' and anything else: not available yet
    }
  };
})();

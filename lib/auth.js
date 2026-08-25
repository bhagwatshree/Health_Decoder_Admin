import crypto from 'crypto';

/**
 * Access control for the whole dashboard.
 *
 * Two accepted credentials, because Lambda Function URLs rewrite the
 * `WWW-Authenticate` response header to `x-amzn-Remapped-www-authenticate`.
 * Browsers ignore the remapped name and never show a login prompt, so the
 * browser path needs a real form:
 *
 *   1. a signed session cookie, issued by POST /login  (browsers)
 *   2. an HTTP Basic Authorization header               (curl, scripts, CI)
 *
 * Fails closed: without DASHBOARD_USER/DASHBOARD_PASSWORD the server refuses
 * to start. DASHBOARD_AUTH_DISABLED=true opts out, for localhost only.
 */

const COOKIE = 'hd_session';
const SESSION_HOURS = 12;

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function sign(value, secret) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

/** Token is `<expiryMs>.<hmac>` — self-contained, so there's no server-side session store. */
function issue(user, secret) {
  const exp = Date.now() + SESSION_HOURS * 3600_000;
  const payload = `${user}|${exp}`;
  return `${exp}.${sign(payload, secret)}`;
}

function verify(token, user, secret) {
  if (typeof token !== 'string' || !token.includes('.')) return false;
  const [expStr, mac] = token.split('.', 2);
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  return safeEqual(mac, sign(`${user}|${exp}`, secret));
}

function readCookie(req, name) {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

function loginPage(error) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Sign in — Health Decoder Admin</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; min-height:100vh; display:grid; place-items:center;
         font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
         background:#f4f4f2; color:#1a1a1a; }
  @media (prefers-color-scheme: dark) { body { background:#141414; color:#ededed; } }
  form { width:min(92vw,340px); padding:28px; border-radius:14px; background:rgba(127,127,127,.10);
         display:flex; flex-direction:column; gap:14px; }
  h1 { margin:0; font-size:17px; }
  label { font-size:12px; text-transform:uppercase; letter-spacing:.06em; opacity:.65; }
  input { width:100%; padding:10px 12px; font-size:15px; border-radius:8px;
          border:1px solid rgba(127,127,127,.45); background:transparent; color:inherit; box-sizing:border-box; }
  button { padding:11px; font-size:15px; font-weight:600; border:0; border-radius:8px;
           background:#2563eb; color:#fff; cursor:pointer; }
  .err { font-size:13px; color:#dc2626; }
</style></head><body>
<form method="POST" action="/login">
  <h1>Health Decoder Admin</h1>
  ${error ? `<div class="err">${error}</div>` : ''}
  <div><label for="u">Username</label><input id="u" name="username" autocomplete="username" autofocus /></div>
  <div><label for="p">Password</label><input id="p" name="password" type="password" autocomplete="current-password" /></div>
  <button type="submit">Sign in</button>
</form></body></html>`;
}

/** Mounts the login routes and the guard. Call before any other route. */
export function installAuth(app, express) {
  const user = process.env.DASHBOARD_USER;
  const password = process.env.DASHBOARD_PASSWORD;

  if (process.env.DASHBOARD_AUTH_DISABLED === 'true') {
    console.warn('WARNING: DASHBOARD_AUTH_DISABLED=true — dashboard is unauthenticated. Never do this on a public host.');
    return;
  }
  if (!user || !password) {
    throw new Error(
      'DASHBOARD_USER and DASHBOARD_PASSWORD must be set (see .env.example). ' +
      'To run without auth locally, set DASHBOARD_AUTH_DISABLED=true.'
    );
  }

  // Distinct from the password so the cookie key isn't the login secret itself.
  const secret = crypto.createHash('sha256')
    .update(process.env.SESSION_SECRET || `${user}:${password}`)
    .digest();

  app.get('/login', (req, res) => res.status(200).type('html').send(loginPage(null)));

  app.post('/login', express.urlencoded({ extended: false }), (req, res) => {
    const okUser = safeEqual(req.body?.username ?? '', user);
    const okPass = safeEqual(req.body?.password ?? '', password);
    if (!(okUser && okPass)) return res.status(401).type('html').send(loginPage('Incorrect username or password.'));

    res.cookie(COOKIE, issue(user, secret), {
      httpOnly: true,
      sameSite: 'lax',
      secure: (req.headers['x-forwarded-proto'] || req.protocol) === 'https',
      maxAge: SESSION_HOURS * 3600_000,
      path: '/',
    });
    res.redirect(302, '/');
  });

  app.get('/logout', (req, res) => {
    res.clearCookie(COOKIE, { path: '/' });
    res.redirect(302, '/login');
  });

  app.use((req, res, next) => {
    if (verify(readCookie(req, COOKIE), user, secret)) return next();

    const header = req.get('authorization') || '';
    if (header.startsWith('Basic ')) {
      let decoded = '';
      try { decoded = Buffer.from(header.slice(6), 'base64').toString('utf8'); } catch { /* fall through */ }
      const sep = decoded.indexOf(':');
      if (sep !== -1) {
        // Compare both halves unconditionally so a wrong username and a wrong
        // password take the same amount of work.
        const okUser = safeEqual(decoded.slice(0, sep), user);
        const okPass = safeEqual(decoded.slice(sep + 1), password);
        if (okUser && okPass) return next();
      }
    }

    // API clients get a machine-readable 401; browsers get the form.
    if (req.path.startsWith('/api/')) {
      res.set('WWW-Authenticate', 'Basic realm="Health Decoder Admin", charset="UTF-8"');
      return res.status(401).json({ error: 'Authentication required' });
    }
    return res.status(401).type('html').send(loginPage(null));
  });
}

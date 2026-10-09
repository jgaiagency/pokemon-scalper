import { createServer as createHttpServer } from 'node:http';
import { access, mkdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { timingSafeEqual } from 'node:crypto';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

function sendJson(response, status, value) {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'",
  });
  response.end(body);
}

function sendHtml(response, body) {
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
  });
  response.end(body);
}

async function readJson(request, limit = 16 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) {
      const error = new Error('Request body is too large');
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {
    const error = new Error('Request body must be valid JSON');
    error.status = 400;
    throw error;
  }
}

function isAuthorized(request, token) {
  if (!token) return true;
  const authorization = request.headers?.authorization ?? '';
  const matches = (actual, expected) => {
    const left = Buffer.from(actual);
    const right = Buffer.from(expected);
    return left.length === right.length && timingSafeEqual(left, right);
  };
  if (authorization.startsWith('Bearer ') && matches(authorization.slice(7), token)) return true;
  if (authorization.startsWith('Basic ')) {
    try {
      const decoded = Buffer.from(authorization.slice(6), 'base64').toString('utf8');
      return matches(decoded, `scalper:${token}`);
    } catch { return false; }
  }
  return false;
}

function isSameOriginMutation(request) {
  if (!String(request.headers?.['content-type'] ?? '').toLowerCase().startsWith('application/json')) return false;
  const fetchSite = String(request.headers?.['sec-fetch-site'] ?? '').toLowerCase();
  if (fetchSite && !['same-origin', 'none'].includes(fetchSite)) return false;
  const origin = request.headers?.origin ?? request.headers?.referer;
  if (!origin) return false;
  try {
    const parsed = new URL(origin);
    const host = String(request.headers?.host ?? '').toLowerCase();
    return ['http:', 'https:'].includes(parsed.protocol)
      && LOOPBACK_HOSTS.has(parsed.hostname)
      && Boolean(host)
      && parsed.host.toLowerCase() === host;
  } catch {
    return false;
  }
}

function dashboardHtml() {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pokémon Scalper Control</title><style>
:root{color-scheme:dark;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:#10131a;color:#edf2f7}body{max-width:1100px;margin:0 auto;padding:24px}h1{font-size:22px}.bar{display:flex;gap:12px;align-items:center;flex-wrap:wrap}.card{background:#191e29;border:1px solid #303849;border-radius:10px;padding:16px;margin:14px 0}button{background:#2867d8;color:white;border:0;border-radius:7px;padding:9px 13px;cursor:pointer}button.danger{background:#b3261e}button.safe{background:#207a48}.ok{color:#62d995}.warn{color:#ffd166}.bad{color:#ff6b6b}table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;border-bottom:1px solid #303849;padding:8px;vertical-align:top}code{word-break:break-word}small{color:#aab4c3}</style></head>
<body><h1>Pokémon Scalper Control</h1><div class="bar"><span id="mode">loading</span><span id="health"></span><button class="danger" id="kill">Activate kill switch</button><button class="safe" id="unkill">Remove file kill switch</button></div>
<section class="card"><h2>Human challenges</h2><div id="challenges"></div></section>
<section class="card"><h2>Purchase tasks</h2><div id="tasks"></div></section>
<section class="card"><h2>Ledger</h2><div id="ledger"></div></section>
<script>
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const table=(rows,columns)=>{if(!rows.length)return '<small>None</small>';const head=columns.map(c=>'<th>'+c+'</th>').join('');const body=rows.map(r=>'<tr>'+columns.map(c=>'<td><code>'+esc(r[c])+'</code></td>').join('')+'</tr>').join('');return '<table><thead><tr>'+head+'</tr></thead><tbody>'+body+'</tbody></table>'};
async function api(path,options){const response=await fetch(path,{...options,headers:{'content-type':'application/json',...(options?.headers||{})}});const value=await response.json();if(!response.ok)throw new Error(value.error||response.status);return value}
async function refresh(){try{const [status,tasks,challenges,ledger]=await Promise.all([api('/api/status'),api('/api/tasks'),api('/api/challenges'),api('/api/ledger')]);document.querySelector('#mode').textContent=status.mode.toUpperCase();document.querySelector('#mode').className=status.mode==='live'?'bad':'warn';document.querySelector('#health').textContent=status.health?.ok?'healthy':'attention required';document.querySelector('#health').className=status.health?.ok?'ok':'warn';document.querySelector('#challenges').innerHTML=table(challenges.map(c=>({...c,action:c.status==='pending'?'<button>Resume</button>':''})),['id','site','kind','status','message']);document.querySelectorAll('#challenges tr').forEach((row,index)=>{const challenge=challenges[index];if(challenge?.status==='pending'){const button=document.createElement('button');button.textContent='Resume';button.onclick=()=>api('/api/challenges/'+encodeURIComponent(challenge.id)+'/resume',{method:'POST',body:'{}'}).then(refresh).catch(show);row.lastElementChild.append(button)}});document.querySelector('#tasks').innerHTML=table(tasks,['id','site','product','state','updatedAt']);document.querySelector('#ledger').innerHTML=table(ledger,['id','site','product','status','amount','quantity','orderId']);}catch(error){show(error)}}
function show(error){document.querySelector('#health').textContent=error.message;document.querySelector('#health').className='bad'}
document.querySelector('#kill').onclick=()=>api('/api/kill-switch',{method:'POST',body:JSON.stringify({active:true})}).then(refresh).catch(show);document.querySelector('#unkill').onclick=()=>api('/api/kill-switch',{method:'POST',body:JSON.stringify({active:false})}).then(refresh).catch(show);refresh();setInterval(refresh,2000);
</script></body></html>`;
}

export class KillSwitchController {
  constructor({
    env = process.env,
    path = join(env.SCALPER_DATA_DIR || 'data/scalper', 'KILL_SWITCH'),
    exists = async (target) => access(target).then(() => true, () => false),
    write = async (target) => {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, 'ACTIVE\n', { encoding: 'utf8', mode: 0o600 });
    },
    remove = async (target) => unlink(target).catch((error) => { if (error?.code !== 'ENOENT') throw error; }),
  } = {}) {
    this.env = env;
    this.path = path;
    this.exists = exists;
    this.write = write;
    this.remove = remove;
  }

  async status() {
    const environment = this.env.SCALPER_KILL_SWITCH === '1';
    const file = await this.exists(this.path);
    return { active: environment || file, environment, file, path: this.path };
  }

  async setActive(active) {
    if (active) await this.write(this.path);
    else await this.remove(this.path);
    return this.status();
  }
}

export function createDashboardHandler({
  env = process.env,
  healthCheck,
  tasks,
  challenges,
  ledger,
  killSwitch = new KillSwitchController({ env }),
  authToken = env.SCALPER_DASHBOARD_TOKEN,
} = {}) {
  if (env.SCALPER_LIVE === '1' && !authToken) throw new Error('Live dashboard requires SCALPER_DASHBOARD_TOKEN');
  return async (request, response) => {
    if (!isAuthorized(request, authToken)) {
      response.setHeader('www-authenticate', 'Basic realm="Pokemon Scalper"');
      sendJson(response, 401, { error: 'unauthorized' });
      return;
    }
    const url = new URL(request.url, 'http://localhost');
    try {
      if (request.method === 'POST' && !isSameOriginMutation(request)) {
        return sendJson(response, 403, { error: 'same-origin application/json request required' });
      }
      if (request.method === 'GET' && url.pathname === '/') return sendHtml(response, dashboardHtml());
      if (request.method === 'GET' && url.pathname === '/api/status') {
        const health = await healthCheck?.();
        return sendJson(response, 200, {
          mode: env.SCALPER_LIVE === '1' ? 'live' : 'paper',
          health,
          killSwitch: await killSwitch.status(),
        });
      }
      if (request.method === 'GET' && url.pathname === '/api/tasks') return sendJson(response, 200, await tasks?.list?.() ?? []);
      if (request.method === 'GET' && url.pathname === '/api/challenges') return sendJson(response, 200, await challenges?.list?.() ?? []);
      if (request.method === 'GET' && url.pathname === '/api/ledger') return sendJson(response, 200, await ledger?.records?.() ?? []);
      const resume = url.pathname.match(/^\/api\/challenges\/([^/]+)\/resume$/);
      if (request.method === 'POST' && resume) {
        const body = await readJson(request);
        const result = await challenges?.resume?.(decodeURIComponent(resume[1]), { actor: 'dashboard', note: body.note });
        return sendJson(response, 200, result);
      }
      if (request.method === 'POST' && url.pathname === '/api/kill-switch') {
        const body = await readJson(request);
        if (typeof body.active !== 'boolean') return sendJson(response, 400, { error: 'active must be boolean' });
        return sendJson(response, 200, await killSwitch.setActive(body.active));
      }
      return sendJson(response, 404, { error: 'not found' });
    } catch (error) {
      return sendJson(response, error.status ?? (error.code === 'SCALPER_CHALLENGE_NOT_ACTIVE' ? 409 : 500), {
        error: error.message,
        ...(error.code ? { code: error.code } : {}),
      });
    }
  };
}

export function createDashboardServer({
  host = '127.0.0.1',
  port = 4317,
  createServer = createHttpServer,
  ...dependencies
} = {}) {
  if (!LOOPBACK_HOSTS.has(host)) throw new Error('Dashboard must bind to a loopback host');
  const server = createServer(createDashboardHandler(dependencies));
  return {
    server,
    async start() {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => { server.off('error', reject); resolve(); });
      });
      const address = server.address();
      return { host, port: typeof address === 'object' && address ? address.port : port, url: `http://${host}:${typeof address === 'object' && address ? address.port : port}` };
    },
    async stop() {
      if (!server.listening) return;
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

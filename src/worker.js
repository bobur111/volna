// Волна — мессенджер без номера телефона.
// Один Worker: отдаёт страницу (GET /) и обслуживает API (/api/*).
// Все данные (пользователи, сообщения) хранятся в Cloudflare D1, не в браузере.

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=UTF-8" },
  });
}

function uid() {
  return crypto.randomUUID();
}

function convKey(a, b) {
  return [a.toLowerCase(), b.toLowerCase()].sort().join("::");
}

async function getUserFromAuth(request, env) {
  const auth = request.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token) return null;
  const row = await env.DB.prepare(
    "SELECT id, username, token FROM users WHERE token = ?"
  )
    .bind(token)
    .first();
  return row || null;
}

async function handleApi(request, env, url) {
  const { pathname } = url;
  const method = request.method;

  // --- регистрация нового пользователя по имени ---
  if (pathname === "/api/register" && method === "POST") {
    const body = await request.json().catch(() => ({}));
    let username = (body.username || "").trim();
    if (!/^[a-zA-Z0-9а-яА-ЯёЁ_]{3,20}$/.test(username)) {
      return json(
        { error: "Имя от 3 до 20 символов: буквы, цифры, подчёркивание." },
        400
      );
    }
    const lower = username.toLowerCase();
    const exists = await env.DB.prepare(
      "SELECT id FROM users WHERE username_lower = ?"
    )
      .bind(lower)
      .first();
    if (exists) {
      return json({ error: "Это имя уже занято." }, 409);
    }
    const id = uid();
    const token = uid() + uid();
    await env.DB.prepare(
      "INSERT INTO users (id, username, username_lower, token, created_at) VALUES (?,?,?,?,?)"
    )
      .bind(id, username, lower, token, Date.now())
      .run();
    return json({ username, token });
  }

  // --- вход по ранее выданному коду (на новом устройстве) ---
  if (pathname === "/api/login" && method === "POST") {
    const body = await request.json().catch(() => ({}));
    const token = (body.token || "").trim();
    const row = await env.DB.prepare(
      "SELECT username FROM users WHERE token = ?"
    )
      .bind(token)
      .first();
    if (!row) return json({ error: "Код не найден." }, 401);
    return json({ username: row.username, token });
  }

  // --- всё остальное требует авторизации ---
  const me = await getUserFromAuth(request, env);
  if (!me) return json({ error: "Не авторизован." }, 401);

  if (pathname === "/api/me" && method === "GET") {
    return json({ username: me.username });
  }

  // --- поиск пользователей по имени ---
  if (pathname === "/api/search" && method === "GET") {
    const q = (url.searchParams.get("q") || "").trim().toLowerCase();
    if (!q) return json({ users: [] });
    const rows = await env.DB.prepare(
      "SELECT username FROM users WHERE username_lower LIKE ? AND username_lower != ? LIMIT 20"
    )
      .bind(`%${q}%`, me.username.toLowerCase())
      .all();
    return json({ users: rows.results.map((r) => r.username) });
  }

  // --- список диалогов с последним сообщением ---
  if (pathname === "/api/conversations" && method === "GET") {
    const rows = await env.DB.prepare(
      `SELECT other_user, body, created_at FROM (
         SELECT
           CASE WHEN from_user = ?1 THEN to_user ELSE from_user END AS other_user,
           body, created_at,
           ROW_NUMBER() OVER (PARTITION BY conv_key ORDER BY created_at DESC) AS rn
         FROM messages
         WHERE from_user = ?1 OR to_user = ?1
       ) WHERE rn = 1
       ORDER BY created_at DESC`
    )
      .bind(me.username)
      .all();
    return json({ conversations: rows.results });
  }

  // --- сообщения одного диалога ---
  if (pathname === "/api/messages" && method === "GET") {
    const withUser = url.searchParams.get("with") || "";
    if (!withUser) return json({ error: "Не указан собеседник." }, 400);
    const key = convKey(me.username, withUser);
    const rows = await env.DB.prepare(
      "SELECT from_user, to_user, body, created_at FROM messages WHERE conv_key = ? ORDER BY created_at ASC LIMIT 300"
    )
      .bind(key)
      .all();
    return json({ messages: rows.results });
  }

  // --- отправка сообщения ---
  if (pathname === "/api/send" && method === "POST") {
    const body = await request.json().catch(() => ({}));
    const to = (body.to || "").trim();
    const text = (body.body || "").trim();
    if (!to || !text) return json({ error: "Пустое сообщение." }, 400);
    if (text.length > 4000) return json({ error: "Слишком длинное сообщение." }, 400);
    const toUser = await env.DB.prepare(
      "SELECT username FROM users WHERE username_lower = ?"
    )
      .bind(to.toLowerCase())
      .first();
    if (!toUser) return json({ error: "Такого пользователя нет." }, 404);
    const key = convKey(me.username, toUser.username);
    const now = Date.now();
    await env.DB.prepare(
      "INSERT INTO messages (conv_key, from_user, to_user, body, created_at) VALUES (?,?,?,?,?)"
    )
      .bind(key, me.username, toUser.username, text, now)
      .run();
    return json({ ok: true, created_at: now });
  }

  return json({ error: "Неизвестный маршрут." }, 404);
}

const HTML = `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Волна — мессенджер без номера</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Sora:wght@300;400;500;600;700&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<style>
:root{
  --bg-deep:#061426; --bg-mid:#0c2340;
  --blue-1:#1e5fbf; --blue-2:#4da8ff; --cyan:#7fe3ff;
  --ink:#eaf4ff; --ink-dim:rgba(234,244,255,0.62); --ink-faint:rgba(234,244,255,0.38);
  --glass-fill:rgba(255,255,255,0.07); --glass-fill-strong:rgba(255,255,255,0.12);
  --glass-border:rgba(255,255,255,0.22); --shadow-deep:rgba(2,10,25,0.55);
}
*{box-sizing:border-box;}
html,body{margin:0;padding:0;height:100%;}
body{
  font-family:'Inter',sans-serif; color:var(--ink); min-height:100vh; overflow-x:hidden;
  background:
    radial-gradient(1200px 800px at 15% -10%, rgba(77,168,255,0.25), transparent 60%),
    radial-gradient(1000px 700px at 110% 10%, rgba(127,227,255,0.18), transparent 55%),
    linear-gradient(160deg, var(--bg-deep) 0%, var(--bg-mid) 55%, #081a30 100%);
  position:relative;
}
.blob{position:fixed;border-radius:50%;filter:blur(60px);opacity:0.5;z-index:0;pointer-events:none;}
.blob-a{width:520px;height:520px;top:-160px;left:-140px;background:radial-gradient(circle at 30% 30%, rgba(77,168,255,0.55), rgba(77,168,255,0) 70%);animation:drift1 22s ease-in-out infinite;}
.blob-b{width:460px;height:460px;bottom:-180px;right:-120px;background:radial-gradient(circle at 60% 60%, rgba(127,227,255,0.45), rgba(127,227,255,0) 70%);animation:drift2 26s ease-in-out infinite;}
@keyframes drift1{0%,100%{transform:translate(0,0) scale(1);}50%{transform:translate(60px,50px) scale(1.08);}}
@keyframes drift2{0%,100%{transform:translate(0,0) scale(1);}50%{transform:translate(-50px,-40px) scale(1.06);}}
@media (prefers-reduced-motion:reduce){.blob{animation:none;}}

#app{position:relative;z-index:1;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;}

.card{
  position:relative; width:100%; max-width:420px;
  background:linear-gradient(180deg, var(--glass-fill-strong), var(--glass-fill));
  border:1px solid var(--glass-border); border-radius:28px; padding:36px 30px;
  backdrop-filter:blur(22px) saturate(140%); -webkit-backdrop-filter:blur(22px) saturate(140%);
  box-shadow:0 30px 60px var(--shadow-deep), inset 0 1px 0 rgba(255,255,255,0.35);
}
.brand{display:flex;align-items:center;gap:10px;margin-bottom:26px;}
.brand-mark{width:30px;height:30px;border-radius:10px;background:linear-gradient(135deg,var(--blue-2),var(--cyan));flex:none;}
.brand-name{font-family:'Sora',sans-serif;font-weight:600;font-size:1.1rem;}

.card h2{font-family:'Sora',sans-serif;font-weight:500;font-size:1.3rem;margin:0 0 6px;}
.card p.sub{color:var(--ink-faint);font-size:0.88rem;margin:0 0 22px;line-height:1.5;}

input[type=text]{
  width:100%; padding:13px 15px; border-radius:14px; border:1px solid rgba(255,255,255,0.22);
  background:rgba(255,255,255,0.08); color:var(--ink); font-size:0.95rem; margin-bottom:10px; outline:none;
}
input[type=text]::placeholder{color:var(--ink-faint);}
input[type=text]:focus{border-color:var(--cyan);}

.btn{
  width:100%; padding:13px 16px; border-radius:14px; border:none; cursor:pointer;
  font-family:'Inter',sans-serif; font-weight:600; font-size:0.94rem; margin-bottom:10px;
  transition:transform 0.15s ease;
}
.btn:active{transform:scale(0.98);}
.btn-primary{background:linear-gradient(135deg,var(--blue-1),var(--blue-2));color:#eef7ff;}
.btn-ghost{background:rgba(255,255,255,0.08);color:var(--ink);border:1px solid rgba(255,255,255,0.18);}

.divider{display:flex;align-items:center;gap:12px;margin:20px 0 14px;color:var(--ink-faint);font-size:0.78rem;}
.divider::before,.divider::after{content:"";flex:1;height:1px;background:rgba(255,255,255,0.14);}

.error{color:#ff9b9b;font-size:0.82rem;margin:-4px 0 10px;min-height:1em;}
.hint{font-size:0.78rem;color:var(--ink-faint);text-align:center;margin-top:8px;line-height:1.5;}

.code-box{
  background:rgba(0,0,0,0.25); border:1px solid var(--glass-border); border-radius:14px;
  padding:16px; margin:16px 0; font-size:0.85rem; word-break:break-all; color:var(--cyan); text-align:center;
}

/* ---- чат ---- */
#chatApp{display:none; width:100%; max-width:920px; height:min(720px, 90vh);
  background:linear-gradient(180deg,var(--glass-fill),rgba(255,255,255,0.03));
  border:1px solid var(--glass-border); border-radius:26px; overflow:hidden;
  backdrop-filter:blur(20px) saturate(130%); -webkit-backdrop-filter:blur(20px) saturate(130%);
  box-shadow:0 30px 60px var(--shadow-deep); display:none; grid-template-columns:280px 1fr;}
#chatApp.active{display:grid;}
@media (max-width:720px){#chatApp{grid-template-columns:1fr;} }

.sidebar{border-right:1px solid rgba(255,255,255,0.1); display:flex; flex-direction:column; min-height:0;}
.sidebar-head{padding:18px 16px 12px; display:flex; align-items:center; justify-content:space-between; gap:8px;}
.me-name{font-family:'Sora',sans-serif; font-weight:600; font-size:1rem;}
.icon-btn{background:none;border:none;color:var(--ink-faint);cursor:pointer;font-size:0.78rem;}
.search-wrap{padding:0 16px 12px;}
.search-wrap input{margin:0;}
.results, .conv-list{overflow-y:auto; flex:1;}
.list-item{
  padding:12px 16px; display:flex; flex-direction:column; gap:2px; cursor:pointer;
  border-bottom:1px solid rgba(255,255,255,0.05);
}
.list-item:hover{background:rgba(255,255,255,0.06);}
.list-item.active{background:rgba(77,168,255,0.15);}
.list-item .name{font-weight:600; font-size:0.9rem;}
.list-item .preview{font-size:0.78rem; color:var(--ink-faint); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;}

.chat-pane{display:flex; flex-direction:column; min-height:0;}
.chat-head{padding:16px 20px; border-bottom:1px solid rgba(255,255,255,0.08); font-family:'Sora',sans-serif; font-weight:500;}
.chat-empty{flex:1; display:flex; align-items:center; justify-content:center; color:var(--ink-faint); font-size:0.9rem; text-align:center; padding:20px;}
.messages{flex:1; overflow-y:auto; padding:18px 20px; display:flex; flex-direction:column; gap:10px;}
.msg{max-width:72%; padding:11px 15px; border-radius:16px; font-size:0.9rem; line-height:1.4;}
.msg.them{align-self:flex-start; background:rgba(255,255,255,0.1); border-bottom-left-radius:5px;}
.msg.me{align-self:flex-end; background:linear-gradient(135deg,var(--blue-1),var(--blue-2)); color:#eef7ff; border-bottom-right-radius:5px;}
.msg .meta{display:block; margin-top:4px; font-size:0.68rem; opacity:0.6;}
.composer{display:flex; gap:8px; padding:14px 16px; border-top:1px solid rgba(255,255,255,0.08);}
.composer input{margin:0;}
.composer button{width:auto; padding:12px 18px; margin:0;}
</style>
</head>
<body>
<div class="blob blob-a"></div>
<div class="blob blob-b"></div>

<div id="app">

  <div class="card" id="authCard">
    <div class="brand"><div class="brand-mark"></div><div class="brand-name">Волна</div></div>

    <div id="registerView">
      <h2>Создать профиль</h2>
      <p class="sub">Придумайте имя пользователя — по нему вас будут находить другие.</p>
      <input type="text" id="regUsername" placeholder="Например, dasha_k">
      <div class="error" id="regError"></div>
      <button class="btn btn-primary" id="regSubmit">Создать и войти</button>
      <div class="divider">или</div>
      <button class="btn btn-ghost" id="showLogin">У меня уже есть код входа</button>
    </div>

    <div id="loginView" style="display:none;">
      <h2>Войти по коду</h2>
      <p class="sub">Вставьте код, который вы сохранили при регистрации.</p>
      <input type="text" id="loginToken" placeholder="Код входа">
      <div class="error" id="loginError"></div>
      <button class="btn btn-primary" id="loginSubmit">Войти</button>
      <div class="divider">или</div>
      <button class="btn btn-ghost" id="showRegister">Создать новый профиль</button>
    </div>

    <div id="codeView" style="display:none;">
      <h2>Сохраните код входа</h2>
      <p class="sub">Это единственный способ зайти в аккаунт с другого устройства. Мы не храним пароли — потеряете код, потеряете доступ.</p>
      <div class="code-box" id="codeText"></div>
      <button class="btn btn-primary" id="codeContinue">Код сохранён, продолжить</button>
    </div>
  </div>

  <div id="chatApp">
    <div class="sidebar">
      <div class="sidebar-head">
        <div class="me-name" id="meName"></div>
        <button class="icon-btn" id="logoutBtn">выйти</button>
      </div>
      <div class="search-wrap"><input type="text" id="searchInput" placeholder="Найти по имени пользователя"></div>
      <div class="results" id="searchResults"></div>
      <div class="conv-list" id="convList"></div>
    </div>
    <div class="chat-pane">
      <div class="chat-head" id="chatHead" style="display:none;"></div>
      <div class="chat-empty" id="chatEmpty">Выберите диалог или найдите человека по имени пользователя</div>
      <div class="messages" id="messages" style="display:none;"></div>
      <div class="composer" id="composer" style="display:none;">
        <input type="text" id="msgInput" placeholder="Сообщение">
        <button class="btn btn-primary" id="sendBtn">Отправить</button>
      </div>
    </div>
  </div>

</div>

<script>
const $ = (id) => document.getElementById(id);
let TOKEN = localStorage.getItem('volna_token') || '';
let ME = '';
let currentPeer = null;
let pollMsgTimer = null, pollConvTimer = null;

function api(path, opts={}) {
  opts.headers = Object.assign({'content-type':'application/json'}, opts.headers||{});
  if (TOKEN) opts.headers['authorization'] = 'Bearer ' + TOKEN;
  return fetch('/api' + path, opts).then(async r => {
    const data = await r.json().catch(()=>({}));
    if (!r.ok) throw new Error(data.error || 'Ошибка сети');
    return data;
  });
}

function showAuth() { $('authCard').style.display='block'; $('chatApp').classList.remove('active'); }
function showChat() { $('authCard').style.display='none'; $('chatApp').classList.add('active'); }

$('showLogin').onclick = () => { $('registerView').style.display='none'; $('loginView').style.display='block'; };
$('showRegister').onclick = () => { $('loginView').style.display='none'; $('registerView').style.display='block'; };

$('regSubmit').onclick = async () => {
  const username = $('regUsername').value.trim();
  $('regError').textContent = '';
  try {
    const data = await api('/register', {method:'POST', body: JSON.stringify({username})});
    TOKEN = data.token; ME = data.username;
    localStorage.setItem('volna_token', TOKEN);
    $('codeText').textContent = TOKEN;
    $('registerView').style.display='none';
    $('codeView').style.display='block';
  } catch(e) { $('regError').textContent = e.message; }
};

$('loginSubmit').onclick = async () => {
  const token = $('loginToken').value.trim();
  $('loginError').textContent = '';
  try {
    const data = await api('/login', {method:'POST', body: JSON.stringify({token})});
    TOKEN = token; ME = data.username;
    localStorage.setItem('volna_token', TOKEN);
    enterChat();
  } catch(e) { $('loginError').textContent = e.message; }
};

$('codeContinue').onclick = () => enterChat();

$('logoutBtn').onclick = () => {
  localStorage.removeItem('volna_token');
  TOKEN=''; ME=''; currentPeer=null;
  clearInterval(pollMsgTimer); clearInterval(pollConvTimer);
  location.reload();
};

async function enterChat() {
  $('meName').textContent = '@' + ME;
  showChat();
  loadConversations();
  pollConvTimer = setInterval(loadConversations, 5000);
}

async function loadConversations() {
  try {
    const data = await api('/conversations');
    const el = $('convList'); el.innerHTML = '';
    data.conversations.forEach(c => {
      const div = document.createElement('div');
      div.className = 'list-item' + (currentPeer===c.other_user ? ' active':'');
      div.innerHTML = '<div class="name">@'+c.other_user+'</div><div class="preview">'+escapeHtml(c.body)+'</div>';
      div.onclick = () => openChat(c.other_user);
      el.appendChild(div);
    });
  } catch(e) {}
}

let searchTimer=null;
$('searchInput').oninput = (e) => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  const el = $('searchResults');
  if (!q) { el.innerHTML=''; return; }
  searchTimer = setTimeout(async () => {
    try {
      const data = await api('/search?q=' + encodeURIComponent(q));
      el.innerHTML = '';
      data.users.forEach(u => {
        const div = document.createElement('div');
        div.className = 'list-item';
        div.innerHTML = '<div class="name">@'+u+'</div><div class="preview">начать диалог</div>';
        div.onclick = () => { $('searchInput').value=''; el.innerHTML=''; openChat(u); };
        el.appendChild(div);
      });
      if (!data.users.length) el.innerHTML = '<div class="list-item" style="cursor:default;"><div class="preview">Никого не найдено</div></div>';
    } catch(e) {}
  }, 250);
};

function openChat(peer) {
  currentPeer = peer;
  $('chatHead').style.display='block';
  $('chatHead').textContent = '@' + peer;
  $('chatEmpty').style.display='none';
  $('messages').style.display='flex';
  $('composer').style.display='flex';
  loadMessages();
  clearInterval(pollMsgTimer);
  pollMsgTimer = setInterval(loadMessages, 3000);
}

async function loadMessages() {
  if (!currentPeer) return;
  try {
    const data = await api('/messages?with=' + encodeURIComponent(currentPeer));
    const el = $('messages');
    const wasAtBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 40;
    el.innerHTML = '';
    data.messages.forEach(m => {
      const div = document.createElement('div');
      div.className = 'msg ' + (m.from_user === ME ? 'me' : 'them');
      const time = new Date(m.created_at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
      div.innerHTML = escapeHtml(m.body) + '<span class="meta">'+time+'</span>';
      el.appendChild(div);
    });
    if (wasAtBottom) el.scrollTop = el.scrollHeight;
  } catch(e) {}
}

$('sendBtn').onclick = sendMsg;
$('msgInput').addEventListener('keydown', (e) => { if (e.key==='Enter') sendMsg(); });

async function sendMsg() {
  const input = $('msgInput');
  const text = input.value.trim();
  if (!text || !currentPeer) return;
  input.value='';
  try {
    await api('/send', {method:'POST', body: JSON.stringify({to: currentPeer, body: text})});
    loadMessages();
    loadConversations();
  } catch(e) { alert(e.message); }
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// восстановление сессии
(async function init() {
  if (TOKEN) {
    try {
      const data = await api('/me');
      ME = data.username;
      enterChat();
      return;
    } catch(e) { localStorage.removeItem('volna_token'); }
  }
  showAuth();
})();
</script>
</body>
</html>`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "") {
      return new Response(HTML, {
        headers: { "content-type": "text/html; charset=UTF-8" },
      });
    }
    if (url.pathname.startsWith("/api/")) {
      try {
        return await handleApi(request, env, url);
      } catch (err) {
        return json({ error: "Ошибка сервера: " + err.message }, 500);
      }
    }
    return new Response("Not found", { status: 404 });
  },
};

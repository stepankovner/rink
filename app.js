/* RINK — дневник питания, сна и состояния. Хоккей вт/пт + игра на выходных. */
(function () {
'use strict';

const APP_NAME = 'RINK';    // название продукта: шапка и имена скачиваемых файлов
const APP_VERSION = 'v6';   // видно в «Ещё → Данные», чтобы проверить, какая версия загрузилась

/* ============ 1. Утилиты дат ============ */
const DOW = ['вс','пн','вт','ср','чт','пт','сб'];
const MON = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
const MONS = ['янв','фев','мар','апр','мая','июн','июл','авг','сен','окт','ноя','дек'];

const iso = d => d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
const parse = s => { const p = s.split('-'); return new Date(+p[0], +p[1]-1, +p[2]); };
const fmtShort = s => { const d = parse(s); return d.getDate()+' '+MONS[d.getMonth()]; };
const fmtLong  = s => { const d = parse(s); return d.getDate()+' '+MON[d.getMonth()]+', '+DOW[d.getDay()]; };
const addDays = (s,n) => { const d = parse(s); d.setDate(d.getDate()+n); return iso(d); };
const monday = d => { const x = new Date(d); x.setDate(x.getDate()-((x.getDay()+6)%7)); x.setHours(0,0,0,0); return x; };
const toMin = t => { if(!t) return null; const p = t.split(':'); return +p[0]*60 + +p[1]; };
const fromMin = m => String(Math.floor(m/60)%24).padStart(2,'0')+':'+String(m%60).padStart(2,'0');
const hm = m => Math.floor(m/60)+' ч '+String(m%60).padStart(2,'0')+' мин';
const num = v => { if (v===''||v==null) return null; const x = +String(v).replace(',','.'); return isNaN(x) ? null : x; };
const dec = v => String(v==null?'':v).replace(',','.').replace(/[^0-9.\-]/g,'');
// «Сегодня» до 04:00 — это ещё вчерашний день: лёд заканчивается в 23:45, а ест он в час ночи.
function todayKey() { const d = new Date(); if (d.getHours() < 4) d.setDate(d.getDate()-1); return iso(d); }

/* ============ 2. Состояние и хранилище ============ */
const LS = 'rink-v1', LS_AUTH = 'rink-auth', LS_DIRTY = 'rink-dirty', LS_PULL = 'rink-pull';
const store = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } },
  del(k) { try { localStorage.removeItem(k); } catch (e) {} }
};
const DEF_CFG = { kcal:false, whoop:true, ice:{'2':'22:30','5':'21:00'}, u:0 };

let S = { days:{}, waist:[], custom:[], cfg:Object.assign({},DEF_CFG) };
let sel = todayKey();
let anchor = new Date();
let dirty = new Set();

function loadLocal() {
  try {
    const raw = store.get(LS);
    if (raw) S = JSON.parse(raw);
  } catch (e) { /* первый запуск */ }
  if (!S.days) S.days = {};
  if (!S.waist) S.waist = [];
  if (!S.custom) S.custom = [];
  S.cfg = Object.assign({}, DEF_CFG, S.cfg || {});
  // Записи, сделанные до появления слияния, получают идентификаторы приёмов пищи.
  Object.keys(S.days).forEach(k => {
    const d = S.days[k];
    (d.meals || []).forEach(m => { if (!m.id || m.id === null) m.id = mealId(); if (!m.u) m.u = d.u || Date.now(); });
  });
  try { dirty = new Set(JSON.parse(store.get(LS_DIRTY) || '[]')); } catch (e) { dirty = new Set(); }
}
let saveT = null;
function saveLocal(mark) {
  if (mark) { dirty.add(mark); store.set(LS_DIRTY, JSON.stringify([...dirty])); }
  clearTimeout(saveT);
  saveT = setTimeout(() => {
    if (!store.set(LS, JSON.stringify(S))) toast('Не удалось сохранить на устройстве');
    scheduleSync();
  }, 250);
}
function day(k) { if (!S.days[k]) S.days[k] = {}; return S.days[k]; }
const META = ['u','uf','mdel','deleted'];
// field — имя изменённого поля. Без него слияние между устройствами невозможно:
// нужно знать, какое поле новее, а не какой день целиком.
function touch(k, field) {
  const d = day(k);
  d.u = Date.now();
  if (field) { d.uf = d.uf || {}; d.uf[field] = d.u; }
  saveLocal('day:'+k);
}
function mealId() { return Date.now().toString(36) + Math.random().toString(36).slice(2,7); }
function hasData(k) {
  const d = S.days[k]; if (!d) return false;
  return Object.keys(d).some(f => !META.concat(['type']).includes(f) && d[f]!=='' && d[f]!=null && d[f]!==false &&
    !(Array.isArray(d[f]) && d[f].length===0) && !(typeof d[f]==='object' && !Array.isArray(d[f]) && Object.keys(d[f]).length===0));
}
function typeOf(k) {
  const d = S.days[k]; if (d && d.type) return d.type;
  const w = parse(k).getDay();
  if (w===2 || w===5) return 'ice';
  if (w===6) return 'game';
  return 'rest';
}
function iceTime(k) {
  const d = S.days[k];
  if (d && d.start) return d.start;
  const t = typeOf(k);
  if (t === 'game') return null;              // время игры плавает, берётся только из дня
  return S.cfg.ice[String(parse(k).getDay())] || null;
}

/* ---- Слияние двух версий одного дня, поле за полем ---- */
function present(d, f) {
  if (!d || !(f in d)) return false;
  const v = d[f];
  return v !== '' && v != null && v !== false;
}
function ts(d, f) {
  if (!d) return -1;
  if (d.uf && d.uf[f] != null) return d.uf[f];
  return present(d, f) ? (d.u || 0) : -1;   // старый формат без меток
}
function mergeDay(local, remote) {
  if (!local) return remote;
  if (!remote) return local;
  const out = {}, uf = {}, plain = new Set();
  [local, remote].forEach(o => Object.keys(o).forEach(f => {
    if (!META.includes(f) && f !== 'meals' && f !== 'checks') plain.add(f);
  }));
  plain.forEach(f => {
    const tl = ts(local, f), tr = ts(remote, f);
    const win = tr > tl ? remote : local;                  // при равенстве оставляем местное
    if (f in win) { out[f] = win[f]; uf[f] = Math.max(tl, tr, 0); }
  });
  const ck = {}, keys = new Set([].concat(Object.keys(local.checks||{}), Object.keys(remote.checks||{})));
  keys.forEach(key => {
    const f = 'checks.' + key, tl = ts(local, f), tr = ts(remote, f);
    const win = tr > tl ? remote : local;
    if (win.checks && key in win.checks) { ck[key] = win.checks[key]; uf[f] = Math.max(tl, tr, 0); }
  });
  if (Object.keys(ck).length) out.checks = ck;
  const mdel = Object.assign({}, local.mdel || {});
  Object.keys(remote.mdel || {}).forEach(id => { mdel[id] = Math.max(mdel[id] || 0, remote.mdel[id]); });
  const byId = {};
  [local, remote].forEach(o => (o.meals || []).forEach(m => {
    if (!m.id) m.id = mealId();
    const cur = byId[m.id];
    if (!cur || (m.u || 0) > (cur.u || 0)) byId[m.id] = m;
  }));
  out.meals = Object.keys(byId)
    .filter(id => !(mdel[id] != null && mdel[id] >= (byId[id].u || 0)))
    .map(id => byId[id])
    .sort((a,b) => (a.t||'').localeCompare(b.t||''));
  if (Object.keys(mdel).length) out.mdel = mdel;
  out.uf = uf;
  out.u = Math.max(local.u || 0, remote.u || 0);
  return out;
}

/* ============ 3. Синхронизация с Supabase ============ */
let AUTH = null;
try { AUTH = JSON.parse(store.get(LS_AUTH) || 'null'); } catch (e) {}

function badge(text, cls) {
  const b = document.getElementById('syncBadge');
  b.textContent = text; b.className = 'sync' + (cls ? ' '+cls : '');
}
async function sbFetch(path, opts, retry) {
  opts = opts || {};
  const h = Object.assign({
    'apikey': AUTH.key, 'Content-Type': 'application/json'
  }, opts.headers || {});
  if (AUTH.access) h['Authorization'] = 'Bearer ' + AUTH.access;
  const r = await fetch(AUTH.url.replace(/\/$/,'') + path, Object.assign({}, opts, { headers:h }));
  if (r.status === 401 && !retry && AUTH.refresh) {
    const ok = await refresh();
    if (ok) return sbFetch(path, opts, true);
  }
  return r;
}
let authBroken = false;
async function refresh() {
  try {
    const r = await fetch(AUTH.url.replace(/\/$/,'') + '/auth/v1/token?grant_type=refresh_token', {
      method:'POST', headers:{ 'apikey':AUTH.key, 'Content-Type':'application/json' },
      body: JSON.stringify({ refresh_token: AUTH.refresh })
    });
    if (!r.ok) { authBroken = true; return false; }
    const j = await r.json();
    authBroken = false;
    AUTH.access = j.access_token; AUTH.refresh = j.refresh_token;
    store.set(LS_AUTH, JSON.stringify(AUTH));
    return true;
  } catch (e) { return false; }
}
async function login(url, key, email, pw) {
  const base = url.replace(/\/$/,'');
  const r = await fetch(base + '/auth/v1/token?grant_type=password', {
    method:'POST', headers:{ 'apikey':key, 'Content-Type':'application/json' },
    body: JSON.stringify({ email, password: pw })
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error_description || j.msg || j.message || 'Не удалось войти');
  AUTH = { url:base, key, email, access:j.access_token, refresh:j.refresh_token };
  store.set(LS_AUTH, JSON.stringify(AUTH));
}
function logout() { AUTH = null; store.del(LS_AUTH); store.del(LS_PULL); }

function uidFromToken() {
  try {
    const b = AUTH.access.split('.')[1].replace(/-/g,'+').replace(/_/g,'/');
    return JSON.parse(decodeURIComponent(escape(atob(b + '==='.slice((b.length + 3) % 4))))).sub;
  } catch (e) { return null; }
}
function records(keys) {
  return [...keys].filter(mk => {
    // Пустую заготовку дня отправлять нельзя: на сервере она затрёт живую запись.
    // Заготовка отличается тем, что её никто не трогал — у неё нет метки времени.
    if (!mk.startsWith('day:')) return true;
    const k = mk.slice(4), d = S.days[k];
    if (!d) return true;                       // день удалён — уйдёт тумбстоун
    return hasData(k) || !!d.u;                // очищенный вручную день тоже уйдёт тумбстоуном
  }).map(mk => {
    const [kind, key] = [mk.slice(0, mk.indexOf(':')), mk.slice(mk.indexOf(':')+1)];
    let payload = null;
    if (kind === 'day')   payload = (S.days[key] && hasData(key)) ? S.days[key] : null;
    if (kind === 'waist') payload = S.waist.find(w => w.d === key) || null;
    if (kind === 'cfg')   payload = S.cfg;
    if (kind === 'custom') payload = (S.custom || []).find(c => c.id === key) || null;
    const uid = uidFromToken();
    const fallbackU = (kind === 'day' && S.days[key] && S.days[key].u) || Date.now();
    const row = { kind, key, payload: payload || { deleted:true, u: fallbackU } };
    if (uid) row.user_id = uid;
    return row;
  });
}
function pushEverything() {
  Object.keys(S.days).filter(hasData).forEach(k => dirty.add('day:'+k));
  S.waist.forEach(w => dirty.add('waist:'+w.d));
  (S.custom || []).forEach(c => dirty.add('custom:'+c.id));
  dirty.add('cfg:main');
  store.set(LS_DIRTY, JSON.stringify([...dirty]));
}
let syncT = null, syncing = false;
function scheduleSync() { clearTimeout(syncT); syncT = setTimeout(syncNow, 2500); }

async function syncNow(silent) {
  if (!AUTH || !AUTH.access || syncing) return;
  syncing = true; badge('синхронизация…','warn');
  try {
    if (dirty.size) {
      const rows = records(dirty);
      if (!rows.length) { dirty.clear(); store.set(LS_DIRTY, '[]'); }
      else {
      const r = await sbFetch('/rest/v1/entries?on_conflict=user_id,kind,key', {
        method:'POST',
        headers:{ 'Prefer':'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(rows)
      });
      if (!r.ok) throw new Error('push ' + r.status + ' ' + (await r.text()).slice(0,120));
      dirty.clear(); store.set(LS_DIRTY, '[]');
      }
    }
    const since = store.get(LS_PULL) || '1970-01-01T00:00:00Z';
    const r2 = await sbFetch('/rest/v1/entries?select=kind,key,payload,updated_at&updated_at=gt.' + encodeURIComponent(since) + '&order=updated_at.asc', { method:'GET' });
    if (!r2.ok) throw new Error('pull ' + r2.status);
    const rows = await r2.json();
    let changed = false, newest = since;
    rows.forEach(row => {
      if (row.updated_at > newest) newest = row.updated_at;
      const p = row.payload || {};
      if (row.kind === 'day') {
        const cur = S.days[row.key];
        if (p.deleted) {
          if (cur && (p.u || 0) >= (cur.u || 0)) { delete S.days[row.key]; changed = true; }
        } else {
          const merged = mergeDay(cur, p);
          if (JSON.stringify(merged) !== JSON.stringify(cur)) {
            S.days[row.key] = merged; changed = true;
            dirty.add('day:' + row.key);          // результат слияния вернём на сервер
          }
        }
      } else if (row.kind === 'waist') {
        const i = S.waist.findIndex(w => w.d === row.key);
        const cur = i >= 0 ? S.waist[i] : null;
        if (!cur || (p.u || 0) > (cur.u || 0)) {
          if (p.deleted) { if (i >= 0) S.waist.splice(i,1); }
          else if (i >= 0) S.waist[i] = p; else S.waist.push(p);
          changed = true;
        }
      } else if (row.kind === 'custom') {
        S.custom = S.custom || [];
        const i = S.custom.findIndex(c => c.id === row.key);
        const cur = i >= 0 ? S.custom[i] : null;
        if (!cur || (p.u || 0) > (cur.u || 0)) {
          // Удалённое своё блюдо остаётся тумбстоуном: иначе оно вернётся со второго устройства.
          if (i >= 0) S.custom[i] = p; else S.custom.push(p);
          changed = true;
        }
      } else if (row.kind === 'cfg') {
        if ((p.u || 0) > (S.cfg.u || 0)) { S.cfg = Object.assign({}, DEF_CFG, p); changed = true; }
      }
    });
    store.set(LS_PULL, newest);
    if (dirty.size) store.set(LS_DIRTY, JSON.stringify([...dirty]));
    if (changed) {
      S.waist.sort((a,b) => a.d < b.d ? 1 : -1);
      store.set(LS, JSON.stringify(S));
      renderAll();
      if (!silent) toast('Обновлено с другого устройства');
    }
    if (dirty.size) { syncing = false; return syncNow(true); }   // отдать результат слияния
    badge('синхронизировано','ok');
  } catch (e) {
    badge(authBroken ? 'нужен вход' : 'не синхронизировано','err');
    if (!silent) toast(authBroken ? 'Сессия истекла — войди заново в разделе «Ещё»' : 'Синхронизация не прошла, данные на месте');
  }
  syncing = false;
}

/* ============ 4. Тост ============ */
let tT = null;
function toast(m) {
  const t = document.getElementById('toast');
  t.textContent = m; t.classList.add('on');
  clearTimeout(tT); tT = setTimeout(() => t.classList.remove('on'), 1600);
}

/* ============ 5. Недельная лента ============ */
function renderWeek() {
  const mon = monday(anchor), wrap = document.getElementById('week');
  wrap.innerHTML = '';
  const today = todayKey();
  for (let i = 0; i < 7; i++) {
    const d = new Date(mon); d.setDate(mon.getDate()+i);
    const k = iso(d), t = typeOf(k);
    const b = document.createElement('button');
    b.className = 'wday' + (k===sel?' sel':'') + (hasData(k)?' filled':'') + (k===today?' today':'');
    b.dataset.t = t;
    b.innerHTML = '<span class="dow">'+DOW[d.getDay()]+'</span><span class="num">'+d.getDate()+'</span><span class="bar"></span><span class="dot"></span>';
    b.onclick = () => { sel = k; renderWeek(); renderDay(); };
    wrap.appendChild(b);
  }
  const end = new Date(mon); end.setDate(mon.getDate()+6);
  document.getElementById('weekLbl').textContent = fmtShort(iso(mon)) + ' — ' + fmtShort(iso(end));
}

/* ============ 6. Подсказка дня ============ */
function coachFor(k) {
  const t = typeOf(k), d = parse(k), tm = iceTime(k);
  if (t === 'ice') {
    const start = toMin(tm || '22:30');
    return { lbl:'Ледовый день', tx:'Лёд в '+(tm||'22:30')+'. Последний плотный приём — до '+fromMin((start-180+1440)%1440)+
      ': белок и крупа, мало жира и клетчатки. За час до выхода банан. Углеводы сегодня не режь. После льда обязательно поесть — творог, кефир или протеин.' };
  }
  if (t === 'game') {
    if (tm) {
      const st = toMin(tm);
      return { lbl:'День игры', tx:'Свисток в '+tm+'. Последняя полноценная еда — до '+fromMin((st-195+1440)%1440)+
        ', углеводная и без жира. За час до выхода банан. Между периодами вода. После игры поесть в течение часа: белок плюс углеводы.' };
    }
    return { lbl:'День игры', tx:'Поставь время начала в карточке «Лёд» — тогда подскажу, до скольки есть. Общее правило: последняя полноценная еда за 3–3,5 часа до свистка, за час банан без жира, после игры поесть в течение часа.' };
  }
  const yest = typeOf(addDays(k,-1)), tom = typeOf(addDays(k,1));
  if (yest === 'game') return { lbl:'После игры', tx:'Сегодня еду не режь, дай восстановиться. Белок в каждый приём, вода, спать пораньше. Дефицит вернёшь завтра.' };
  if (tom === 'ice')  return { lbl:'Завтра лёд', tx:'Обычный день дефицита: белок в каждый приём, овощи в обед и ужин, углеводов горсть. Вечером не наедайся — завтра важнее полный гликоген, а не сегодня.' };
  return { lbl:'День дефицита', tx:'Белок в каждый приём, овощи в обед и ужин, углеводов одна горсть. Плюс 30–40 минут ходьбы: сидячий день — единственная реальная дыра в неделе.' };
}

/* ---- Обратный отсчёт до льда ----
   Смысл подсказки в том, чтобы на неё смотрели днём, а не читали один раз утром. */
function countdownText(k, nowMin) {
  const t = typeOf(k), tm = iceTime(k);
  if (k !== todayKey() || (t !== 'ice' && t !== 'game') || !tm) return '';
  const nrm = m => m < 240 ? m + 1440 : m;
  const left = nrm(toMin(tm)) - nrm(nowMin);
  const word = t === 'game' ? 'игры' : 'льда';
  if (left <= 0) return (t === 'game' ? 'Игра началась' : 'Лёд начался')
    + '. После него обязательно поешь: творог, кефир или протеин.';
  if (left <= 180) return 'До ' + word + ' ' + hm(left)
    + '. Плотно есть уже поздно. Если голодно — банан или хлеб с мёдом, без жира.';
  return 'До ' + word + ' ' + hm(left) + '. Плотно есть можно ещё ' + hm(left - 180) + '.';
}
let cdT = null;
function renderCountdown() {
  const el = document.getElementById('coachNow');
  if (!el) return;
  const n = new Date();
  const tx = countdownText(sel, n.getHours()*60 + n.getMinutes());
  el.textContent = tx;
  el.style.display = tx ? '' : 'none';
  if (!cdT) cdT = setInterval(renderCountdown, 60000);   // пересчёт раз в минуту
}

/* ============ 7. Лента дня ============ */
/* Цвета продублированы литералами: значения из :root в SVG-атрибуты не подставить. */
const TL = { axis:'#26333F', tick:'#5C6E7E', hour:'#6B7F90', sleep:'#1F2C38', sleepLine:'#8094A6',
             muted:'#8094A6', meal:'#F2A93B', red:'#E23B4C', amber:'#F2A93B' };

/* Ширина подписи на глаз: моноширинный шрифт 9px даёт примерно 5.4 px на знак. */
const labW = t => String(t).length * 5.4;

/* Раскладка подписей по двум строкам.
   На входе {x — центр, text, color}, на выходе то же плюс row: 0 — строка у оси, 1 — над ней.
   Подпись, которой не хватило места ни в одной строке, не рисуется вовсе. */
function layoutLabels(items, gap) {
  if (gap == null) gap = 4;
  const edge = [-Infinity, -Infinity], out = [];
  items.slice().sort((a, b) => a.x - b.x).forEach(it => {
    const w = labW(it.text), left = it.x - w/2, right = it.x + w/2;
    for (let r = 0; r < 2; r++) {
      if (left >= edge[r] + gap) { edge[r] = right; out.push(Object.assign({}, it, { row:r })); return; }
    }
  });
  return out;
}

/* Точки ближе min пикселей разводим минимальным сдвигом, порядок сохраняем. */
function spreadPoints(xs, min, lo, hi) {
  const out = xs.slice(), n = out.length;
  for (let i = 1; i < n; i++) if (out[i] - out[i-1] < min) out[i] = out[i-1] + min;
  if (n && out[n-1] > hi) {
    out[n-1] = hi;
    for (let i = n-2; i >= 0; i--) if (out[i+1] - out[i] < min) out[i] = out[i+1] - min;
  }
  if (n && out[0] < lo) {
    out[0] = lo;
    for (let i = 1; i < n; i++) if (out[i] - out[i-1] < min) out[i] = out[i-1] + min;
  }
  return out;
}

/* Шаг подписей часов подбираем так, чтобы их вышло 6–8. */
function hourStep(t0, t1) {
  const opts = [1, 2, 3, 4, 6];
  for (let i = 0; i < opts.length; i++) {
    const s = opts[i];
    const n = Math.floor(t1/60/s) - Math.ceil(t0/60/s) + 1;
    if (n <= 8) return s;
  }
  return 6;
}

const shortT = t => String(t || '').replace(/^0/, '');

function renderTimeline(k) {
  const host = document.getElementById('tl');
  if (!host) return;
  const d = S.days[k] || {}, t = typeOf(k), tm = iceTime(k);
  // Сутки в приложении начинаются в 04:00 (см. todayKey), поэтому ночь уезжает вправо.
  const norm = m => m < 240 ? m + 1440 : m;

  const meals = (d.meals || []).filter(m => m.t).slice()
    .sort((a, b) => norm(toMin(a.t)) - norm(toMin(b.t)));
  const ev = [];
  if (d.wake) ev.push(norm(toMin(d.wake)));
  meals.forEach(m => ev.push(norm(toMin(m.t))));
  let iceA = null, iceB = null;
  if ((t === 'ice' || t === 'game') && tm) {
    iceA = norm(toMin(tm));
    iceB = iceA + (t === 'game' ? 105 : 75);
    ev.push(iceA, iceB);
  }
  if (!ev.length) {
    host.innerHTML = '<div class="tl-empty">Заполни утро и приёмы пищи — здесь появится лента дня</div>';
    return;
  }

  // Виден только тот кусок суток, где что-то происходит, но не уже 06:00–22:00.
  const T0 = Math.max(240, Math.min(6*60, Math.min.apply(null, ev) - 60));
  const T1 = Math.min(240 + 1440, Math.max(22*60, Math.max.apply(null, ev) + 60));

  // Ширину берём фактическую, чтобы 1 единица viewBox равнялась пикселю: иначе
  // подписи растянет вместе с картинкой и оценка ширины перестанет работать.
  const W = Math.round(host.clientWidth) || 600;
  const H = 96, L = 8, R = W - 8, Y = 54, ROW = [40, 27], HY = Y + 22;
  const x = m => L + (R-L) * Math.min(1, Math.max(0, (m - T0) / (T1 - T0)));

  const labels = [];
  const push = (cx, text, color) => {
    const half = labW(text) / 2;
    labels.push({ x: Math.min(R - half, Math.max(L + half, cx)), text, color });
  };

  let s = '<svg viewBox="0 0 '+W+' '+H+'" preserveAspectRatio="none" role="img" aria-label="Лента дня">';

  // сон: полоса от левого края до подъёма
  if (d.wake) {
    const px = x(norm(toMin(d.wake)));
    s += '<rect x="'+L+'" y="'+(Y-6)+'" width="'+Math.max(0, px-L).toFixed(1)+'" height="12" rx="3" fill="'+TL.sleep+'"/>'
      +  '<line x1="'+px.toFixed(1)+'" y1="'+(Y-11)+'" x2="'+px.toFixed(1)+'" y2="'+(Y+11)+'" stroke="'+TL.sleepLine+'" stroke-width="1.5"/>';
    let lab = 'сон';
    const bm = toMin(d.bed);
    if (bm != null) { let mm = toMin(d.wake) - bm; if (mm <= 0) mm += 1440; lab = (mm/60).toFixed(1).replace('.', ',') + ' ч'; }
    push((L + px) / 2, lab, TL.muted);
  }

  // лёд или игра
  if (iceA != null) {
    const a = x(iceA), b = x(iceB);
    s += '<rect class="tl-ice" x="'+a.toFixed(1)+'" y="'+(Y-6)+'" width="'+Math.max(4, b-a).toFixed(1)+'" height="12" rx="3" fill="'+TL.red+'"/>';
    push((a + b) / 2, t === 'game' ? 'игра' : 'лёд', TL.red);
    // Граница, после которой плотно есть уже нельзя. Ради неё лента и нужна.
    const t3 = iceA - 180;
    if (t3 >= T0) {
      const px = x(t3);
      s += '<line class="tl-t3" data-at="'+fromMin((t3 + 1440) % 1440)+'" x1="'+px.toFixed(1)+'" y1="'+(Y-10)+'" x2="'+px.toFixed(1)+'" y2="'+(Y+16)+'" '
        +  'stroke="'+TL.red+'" stroke-width="1" stroke-dasharray="3 3"/>';
      push(px, '-3 ч', TL.red);
    }
  }

  // часовая сетка и ось
  const step = hourStep(T0, T1);
  for (let h = Math.ceil(T0/60/step)*step; h*60 <= T1; h += step) {
    const px = x(h*60);
    s += '<line x1="'+px.toFixed(1)+'" y1="'+(Y-7)+'" x2="'+px.toFixed(1)+'" y2="'+(Y+7)+'" stroke="'+TL.tick+'" stroke-width="1"/>'
      +  '<text class="tl-hour" x="'+px.toFixed(1)+'" y="'+HY+'" fill="'+TL.hour+'" font-size="9" font-family="ui-monospace,monospace" text-anchor="middle">'
      +  String(h % 24).padStart(2, '0') + '</text>';
  }
  s += '<line x1="'+L+'" y1="'+Y+'" x2="'+R+'" y2="'+Y+'" stroke="'+TL.axis+'" stroke-width="2" stroke-linecap="round"/>';

  // метка «сейчас»
  if (k === todayKey()) {
    const now = new Date(), nm = norm(now.getHours()*60 + now.getMinutes());
    if (nm >= T0 && nm <= T1) {
      const px = x(nm);
      s += '<line class="tl-now" x1="'+px.toFixed(1)+'" y1="'+(Y-14)+'" x2="'+px.toFixed(1)+'" y2="'+(Y+14)+'" stroke="'+TL.amber+'" stroke-width="1" opacity=".75"/>';
    }
  }

  // приёмы пищи
  const xs = spreadPoints(meals.map(m => x(norm(toMin(m.t)))), 11, L + 6, R - 6);
  meals.forEach((m, i) => {
    const mm = norm(toMin(m.t));
    // Красным — то, что попало в трёхчасовое окно перед льдом, границу считаем включительно.
    const late = iceA != null && mm <= iceA && (iceA - mm) <= 180;
    s += '<circle class="tl-meal" data-at="'+m.t+'" cx="'+xs[i].toFixed(1)+'" cy="'+Y+'" r="5.5" fill="'+(late ? TL.red : TL.meal)+'" stroke="#0B1117" stroke-width="1.5"/>';
    push(xs[i], shortT(m.t), late ? TL.red : TL.muted);
  });

  layoutLabels(labels).forEach(it => {
    s += '<text class="tl-lab" x="'+it.x.toFixed(1)+'" y="'+ROW[it.row]+'" fill="'+it.color+'" font-size="9" '
      +  'font-family="ui-monospace,monospace" text-anchor="middle">' + it.text + '</text>';
  });

  s += '</svg>';
  host.innerHTML = s;
}

/* ============ 8. Правила ============ */
function rulesFor(k) {
  const t = typeOf(k);
  const base = [
    ['r_protein','Белок в каждый приём пищи','Порция размером с ладонь'],
    ['r_veg','Овощи в обед и ужин',''],
    ['r_liquid','Ноль жидких калорий','Морсы, соки, сладкий кофе']
  ];
  if (t === 'ice' || t === 'game') return base.concat([
    ['r_pre','Поел за 3 часа до льда, без жирного',''],
    ['r_water','Вода с солью или изотоник на льду',''],
    ['r_post','Поел после льда','Творог, кефир или протеин']
  ]);
  return base.concat([['r_move','Движение 30–40 минут','Ходьба или велосипед']]);
}

/* ============ 9. Экран «День» ============ */
function renderDay() {
  const k = sel, d = day(k), t = typeOf(k);

  document.querySelectorAll('[data-k]').forEach(el => {
    el.value = d[el.dataset.k] == null ? '' : d[el.dataset.k];
  });
  renderDayType(k, t);
  renderWeightDelta(k);

  const c = coachFor(k);
  document.getElementById('coachLbl').textContent = fmtLong(k) + ' · ' + c.lbl;
  document.getElementById('coachTxt').textContent = c.tx;
  renderCountdown();

  // сон
  const bm = toMin(d.bed), wm = toMin(d.wake);
  let sleepTxt = 'ночь перед этим утром';
  if (bm != null && wm != null) { let m = wm - bm; if (m <= 0) m += 1440; sleepTxt = 'сон ' + hm(m); }
  document.getElementById('sleepAside').textContent = sleepTxt;

  // правила
  const rw = document.getElementById('rules'); rw.innerHTML = '';
  const rl = rulesFor(k);
  rl.forEach(([key, label, hint]) => {
    const l = document.createElement('label'); l.className = 'chk';
    l.innerHTML = '<input type="checkbox"><span>'+label+(hint?'<small>'+hint+'</small>':'')+'</span>';
    const inp = l.querySelector('input');
    inp.checked = !!(d.checks && d.checks[key]);
    inp.onchange = () => { d.checks = d.checks || {}; d.checks[key] = inp.checked; touch(k, 'checks.'+key); renderWeek(); updateRulesAside(k); };
    rw.appendChild(l);
  });
  updateRulesAside(k);

  renderMeals(k);
  renderTimeline(k);

  // лёд
  document.getElementById('iceCard').style.display = (t==='ice'||t==='game') ? '' : 'none';
  rate('rateP3', d.p3, v => { d.p3 = v; touch(k, 'p3'); renderDay(); });
  rate('rateFeel', d.feel, v => { d.feel = v; touch(k, 'feel'); renderDay(); });

  document.getElementById('whoopCard').style.display = S.cfg.whoop ? '' : 'none';
  document.getElementById('kcalCard').style.display = S.cfg.kcal ? '' : 'none';
  if (S.cfg.kcal) {
    const tg = (t==='ice'||t==='game') ? '2650–2750 ккал, поддержка' : '2050–2150 ккал, дефицит';
    document.getElementById('kcalTarget').innerHTML = 'Цель на сегодня: <b>'+tg+'</b>. Белок 130–160 г в любой день.';
  }
}
function updateRulesAside(k) {
  const d = S.days[k] || {}, rl = rulesFor(k);
  const done = rl.filter(r => d.checks && d.checks[r[0]]).length;
  document.getElementById('rulesAside').textContent = done + ' из ' + rl.length;
}
const DAY_TYPES = [['rest','Обычный'], ['ice','Лёд'], ['game','Игра']];
// Тот же паттерн, что у оценки 1–5: три кнопки в ряд вместо системного колеса выбора.
function renderDayType(k, t) {
  const w = document.getElementById('dayType');
  if (!w) return;
  w.innerHTML = '';
  DAY_TYPES.forEach(([v, label]) => {
    const b = document.createElement('button');
    b.type = 'button'; b.dataset.v = v; b.textContent = label;
    if (v === t) b.className = 'on ' + (v === 'rest' ? 't-rest' : 't-ice');
    b.onclick = () => { day(k).type = v; touch(k, 'type'); renderAll(); };
    w.appendChild(b);
  });
}

/* Насколько сегодняшний вес отличается от среднего за прошедшую неделю. */
function weightDelta(k) {
  const cur = num((S.days[k] || {}).weight);
  if (cur == null) return null;
  const prev = [];
  for (let i = 1; i <= 7; i++) {
    const v = num((S.days[addDays(k, -i)] || {}).weight);
    if (v != null) prev.push(v);
  }
  if (prev.length < 2) return null;          // по одному замеру «за неделю» не считается
  return cur - prev.reduce((a, b) => a + b, 0) / prev.length;
}
function renderWeightDelta(k) {
  const el = document.getElementById('wDelta');
  if (!el) return;
  const d = weightDelta(k);
  if (d == null) { el.textContent = ''; el.className = 'delta'; return; }
  el.textContent = (d > 0 ? '+' : '\u2212') + Math.abs(d).toFixed(1).replace('.', ',') + ' кг за неделю';
  el.className = 'delta ' + (d > 0 ? 'up' : 'down');
}

function rate(id, val, cb) {
  const w = document.getElementById(id); w.innerHTML = '';
  for (let i = 1; i <= 5; i++) {
    const b = document.createElement('button');
    b.textContent = i; if (val === i) b.className = 'on';
    b.onclick = () => cb(val === i ? null : i);
    w.appendChild(b);
  }
}

/* ============ 10. Приёмы пищи ============ */
function renderMeals(k) {
  const d = day(k), wrap = document.getElementById('meals');
  const meals = (d.meals || []).slice().sort((a,b) => (a.t||'').localeCompare(b.t||''));
  d.meals = meals;
  wrap.innerHTML = '';
  if (!meals.length) wrap.innerHTML = '<div class="empty">Пока ничего. Добавь первый приём пищи — время подставится само.</div>';
  meals.forEach((m, i) => {
    const row = document.createElement('div'); row.className = 'meal';
    row.innerHTML = '<div class="mt"><input type="time" value="'+(m.t||'')+'"></div>'
      + '<div class="mn"></div>'
      + '<div class="mp">'+(m.p ? m.p+' г' : '')+'</div>'
      + '<button class="mx" aria-label="Убрать">×</button>';
    row.querySelector('.mn').textContent = m.n || '';
    row.querySelector('input').onchange = e => { m.t = e.target.value; m.u = Date.now(); touch(k); renderMeals(k); renderTimeline(k); };
    row.querySelector('.mx').onclick = () => {
      d.mdel = d.mdel || {};
      if (m.id) d.mdel[m.id] = Date.now();      // чтобы удаление доехало до второго устройства
      meals.splice(i,1); touch(k); renderMeals(k); renderTimeline(k); renderWeek();
    };
    wrap.appendChild(row);
  });
  const tot = meals.reduce((s,m) => s + (m.p||0), 0);
  document.getElementById('proteinAside').textContent = tot ? ('белок ≈ '+tot+' г из 130–160') : '';
  // Полоса до верхней границы цели. Зелёная с нижней границы, красного нет: это не наказание.
  const bar = document.getElementById('proteinBar');
  if (bar) {
    bar.classList.toggle('ok', tot >= 130);
    bar.querySelector('i').style.width = Math.min(100, Math.round(tot / 160 * 100)) + '%';
  }
}
function addMeal(recipe, name, prot) {
  const d = day(sel);
  d.meals = d.meals || [];
  const now = new Date();
  d.meals.push({ id: mealId(), rid: recipe ? recipe.id : null, u: Date.now(),
                 t: String(now.getHours()).padStart(2,'0')+':'+String(now.getMinutes()).padStart(2,'0'),
                 n: name, p: prot || 0 });
  touch(sel); renderMeals(sel); renderTimeline(sel); renderWeek();
}

/* ============ 11. Модалка ============ */
function openModal(title, build) {
  document.getElementById('mTitle').textContent = title;
  const b = document.getElementById('mBody'); b.innerHTML = ''; build(b);
  document.getElementById('modal').classList.add('on');
}
function closeModal() { document.getElementById('modal').classList.remove('on'); }

/* ---- Свои блюда ----
   Записанное своими словами живёт не только внутри дня, иначе через неделю
   вводить заново. Синхронизируется отдельным kind = 'custom'. */
function customList() { return (S.custom || []).filter(c => !c.deleted); }
function saveCustom(n, p) {
  S.custom = S.custom || [];
  const key = norm(n);
  let c = S.custom.find(x => !x.deleted && norm(x.n) === key);
  if (c) {
    if (p && c.p !== p) { c.p = p; c.u = Date.now(); saveLocal('custom:' + c.id); }
    return c;
  }
  c = { id: mealId(), n: n, p: p || 0, u: Date.now() };
  S.custom.push(c);
  saveLocal('custom:' + c.id);
  return c;
}
function delCustom(id) {
  const c = (S.custom || []).find(x => x.id === id);
  if (!c) return;
  c.deleted = true; c.u = Date.now();          // тумбстоун, чтобы удаление доехало
  saveLocal('custom:' + id);
}
function filterCustom(q) {
  const nq = norm(q).trim();
  return customList().filter(c => !nq || nq.split(/\s+/).every(w => norm(c.n).includes(w)));
}

/* Что человек добавляет чаще всего за последние 30 дней.
   Блюда из меню считаем по rid, записанные своими словами — по названию. */
function frequentMeals(limit) {
  const to = todayKey(), from = addDays(to, -29), by = {};
  Object.keys(S.days).forEach(k => {
    if (k < from || k > to) return;
    (S.days[k].meals || []).forEach(m => {
      if (!m.n) return;
      const id = m.rid ? 'r:' + m.rid : 'n:' + norm(m.n);
      const cur = by[id] || (by[id] = { n:m.n, p:m.p || 0, rid:m.rid || null, c:0 });
      cur.c++; cur.n = m.n;
      if (m.p) cur.p = m.p;
    });
  });
  return Object.keys(by).map(id => by[id])
    .sort((a, b) => b.c - a.c || a.n.localeCompare(b.n))
    .slice(0, limit || 6);
}

function mealPicker() {
  openModal('Что ел', box => {
    // «Часто» — сверху: человек ест одно и то же, листать 104 блюда каждый раз незачем.
    const freq = frequentMeals(6);
    if (freq.length) {
      const f = document.createElement('div');
      f.className = 'freq';
      f.innerHTML = '<div class="pickhd">Часто</div><div class="chips"></div>';
      const row = f.querySelector('.chips');
      freq.forEach(it => {
        const b = document.createElement('button');
        b.className = 'chip freqchip';
        b.textContent = it.n + (it.p ? ' · ' + it.p + ' г' : '');
        b.onclick = () => { addMeal(it.rid ? { id:it.rid } : null, it.n, it.p); closeModal(); toast('Добавлено'); };
        row.appendChild(b);
      });
      box.appendChild(f);
    }

    const s = document.createElement('div'); s.className = 'search';
    s.innerHTML = '<input type="text" placeholder="Найти блюдо">';
    box.appendChild(s);
    const own = document.createElement('div');
    own.innerHTML = '<div class="grid2" style="margin-bottom:var(--s2)">'
      + '<div class="f" style="grid-column:1 / -1"><span>Или своими словами</span><input type="text" id="ownName" placeholder="Например, шаурма"></div>'
      + '<div class="f"><span>Белок, г</span><input type="text" inputmode="numeric" class="num" id="ownProt" placeholder="можно пропустить"></div>'
      + '<div class="f" style="align-self:end"><button class="btn" id="ownAdd" style="width:100%">Записать</button></div>'
      + '</div>';
    box.appendChild(own);
    own.querySelector('#ownAdd').onclick = () => {
      const t = own.querySelector('#ownName').value.trim();
      if (!t) { toast('Напиши, что ел'); return; }
      const prot = Math.round(num(own.querySelector('#ownProt').value) || 0);
      saveCustom(t, prot);                     // на следующей неделе будет в «Моих блюдах»
      addMeal(null, t, prot);
      closeModal(); toast('Добавлено');
    };
    const list = document.createElement('div'); box.appendChild(list);
    const draw = q => {
      list.innerHTML = '';
      const mine = filterCustom(q);
      if (mine.length) {
        const h = document.createElement('div'); h.className = 'pickhd'; h.textContent = 'Мои блюда';
        list.appendChild(h);
        mine.forEach(c => {
          const el = document.createElement('div'); el.className = 'pick mine';
          el.innerHTML = '<div><div class="nm"></div><div class="sub">своё блюдо</div></div>'
            + '<div class="meta">'+(c.p ? c.p+' г' : '—')+'</div>'
            + '<button class="mx" aria-label="Убрать из моих">×</button>';
          el.querySelector('.nm').textContent = c.n;
          el.onclick = () => { addMeal(null, c.n, c.p); closeModal(); toast('Добавлено'); };
          el.querySelector('.mx').onclick = e => { e.stopPropagation(); delCustom(c.id); draw(q); toast('Убрано из моих'); };
          list.appendChild(el);
        });
        const h2 = document.createElement('div'); h2.className = 'pickhd'; h2.style.marginTop = 'var(--s4)'; h2.textContent = 'Из меню';
        list.appendChild(h2);
      }
      const res = filterRecipes(q, null).slice(0, 60);
      if (!res.length) {
        if (!mine.length) list.innerHTML = '<div class="empty">Ничего не нашлось. Запиши своими словами.</div>';
        return;
      }
      res.forEach(r => {
        const el = document.createElement('div'); el.className = 'pick';
        el.innerHTML = '<div><div class="nm"></div><div class="sub">'+r.c+(r.s?' · '+r.s:'')+'</div></div><div class="meta">'+r.p+' г · '+r.t+' мин</div>';
        el.querySelector('.nm').textContent = r.n;
        el.onclick = () => { addMeal(r, r.n, r.p); closeModal(); toast('Добавлено'); };
        list.appendChild(el);
      });
    };
    s.querySelector('input').oninput = e => draw(e.target.value);
    draw('');
    setTimeout(() => s.querySelector('input').focus(), 60);
  });
}

/* ============ 12. Экран «Еда» ============ */
const CHIPS = [
  ['all','Всё',null], ['fast','До 10 минут','fast'], ['protein','35+ г белка','protein'],
  ['nocook','Без готовки','nocook'], ['oven','Духовка','oven'], ['prep','На 2–3 порции','prep'],
  ['c:Перед льдом','Перед льдом',null], ['c:После льда','После льда',null],
  ['freezer','Из морозилки','freezer'], ['portable','С собой','portable'], ['light','Мало жира','light']
];
let chip = 'all', query = '';
const norm = s => (s||'').toLowerCase().replace(/ё/g,'е');

function filterRecipes(q, ch) {
  const nq = norm(q).trim();
  return RECIPES.filter(r => {
    if (ch && ch !== 'all') {
      if (ch.startsWith('c:')) { if (r.c !== ch.slice(2)) return false; }
      else if (!(r.tags||[]).includes(ch)) return false;
    }
    if (!nq) return true;
    const hay = norm([r.n, r.c, r.s, (r.ing||[]).join(' '), (r.st||[]).join(' '), r.tip].join(' '));
    return nq.split(/\s+/).every(w => hay.includes(w));
  });
}
function hl(text, q) {
  const nq = norm(q).trim();
  const esc = t => t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  if (!nq) return esc(text);
  let out = esc(text);
  nq.split(/\s+/).filter(Boolean).forEach(w => {
    const re = new RegExp('(' + w.replace(/[.*+?^${}()|[\]\\]/g,'\\$&') + ')', 'gi');
    out = out.replace(re, '<mark>$1</mark>');
  });
  return out;
}
function renderChips() {
  const w = document.getElementById('chips'); w.innerHTML = '';
  CHIPS.forEach(([id,label]) => {
    const b = document.createElement('button');
    b.className = 'chip' + (chip===id ? ' on' : ''); b.textContent = label;
    b.onclick = () => { chip = id; renderChips(); renderFood(); };
    w.appendChild(b);
  });
}
const ORDER = ['Завтрак','Обед','Ужин','Перед льдом','После льда','Перекус','Соусы','Заготовки'];
let openSec = {}, openItem = {};

function renderFood() {
  const res = filterRecipes(query, chip);
  const wrap = document.getElementById('foodList'); wrap.innerHTML = '';
  if (!res.length) { wrap.innerHTML = '<div class="empty">Ничего не нашлось. Попробуй другое слово или сбрось фильтр.</div>'; return; }
  const groups = {}; res.forEach(r => { (groups[r.c] = groups[r.c] || []).push(r); });
  ORDER.filter(c => groups[c]).forEach(c => {
    const isOpen = query.trim() ? true : !!openSec[c];
    const sec = document.createElement('div'); sec.className = 'sec' + (isOpen ? ' open' : '');
    sec.innerHTML = '<button class="sh">'+c+'<span class="cnt">'+groups[c].length+'</span></button><div class="body"></div>';
    sec.querySelector('.sh').onclick = () => { openSec[c] = !isOpen; renderFood(); };
    const body = sec.querySelector('.body');
    groups[c].forEach(r => body.appendChild(recipeEl(r)));
    wrap.appendChild(sec);
  });
}
function recipeEl(r) {
  const el = document.createElement('div');
  el.className = 'item' + (openItem[r.id] ? ' open' : '');
  const meta = r.p + ' г · ' + r.t + ' мин' + (r.h && r.h < r.t ? ' (руки ' + r.h + ')' : '');
  el.innerHTML = '<div class="hd"><span class="nm">'+hl(r.n, query)+'</span><span class="meta">'+meta+'</span></div>'
    + '<div class="det">'
    + (r.s ? '<div style="color:#5C6E7E;font-size:12px">'+r.s+' · примерно '+r.k+' ккал</div>' : '<div style="color:#5C6E7E;font-size:12px">Примерно '+r.k+' ккал</div>')
    + '<h4>Нужно</h4><ul>' + (r.ing||[]).map(i => '<li>'+hl(i, query)+'</li>').join('') + '</ul>'
    + '<h4>Как</h4><ol>' + (r.st||[]).map(i => '<li>'+hl(i, query)+'</li>').join('') + '</ol>'
    + (r.tip ? '<div class="tip">'+hl(r.tip, query)+'</div>' : '')
    + '<div class="adds"><button class="btn sm">Записать в день</button></div>'
    + '</div>';
  el.querySelector('.hd').onclick = () => { openItem[r.id] = !openItem[r.id]; renderFood(); };
  el.querySelector('.adds button').onclick = e => {
    e.stopPropagation(); addMeal(r, r.n, r.p); toast('Добавлено в ' + fmtShort(sel));
  };
  return el;
}
function renderGuide() {
  const wrap = document.getElementById('guideList'); wrap.innerHTML = '';
  GUIDE.forEach((g, gi) => {
    const isOpen = !!openSec['g'+gi];
    const sec = document.createElement('div'); sec.className = 'sec' + (isOpen ? ' open' : '');
    sec.innerHTML = '<button class="sh">'+g.t+'<span class="cnt">'+g.items.length+'</span></button><div class="body"></div>';
    sec.querySelector('.sh').onclick = () => { openSec['g'+gi] = !isOpen; renderGuide(); };
    const body = sec.querySelector('.body');
    g.items.forEach(it => {
      const d = document.createElement('div'); d.className = 'gitem';
      d.innerHTML = '<div class="nm"></div><div class="d"></div>';
      d.querySelector('.nm').textContent = it.n; d.querySelector('.d').textContent = it.d;
      body.appendChild(d);
    });
    wrap.appendChild(sec);
  });
}
function suggest() {
  const h = new Date().getHours(), t = typeOf(sel), tm = toMin(iceTime(sel) || '22:30');
  const nowM = h*60 + new Date().getMinutes();
  let pool, why;
  if ((t==='ice'||t==='game') && nowM > tm) { pool = RECIPES.filter(r => r.c==='После льда'); why = 'После льда: лёгкое и белковое, не жирное.'; }
  else if ((t==='ice') && tm - nowM < 240 && tm - nowM > 60) { pool = RECIPES.filter(r => r.c==='Перед льдом'); why = 'До льда меньше четырёх часов: мало жира и клетчатки.'; }
  else if (h < 11) { pool = RECIPES.filter(r => r.c==='Завтрак'); why = 'Утро.'; }
  else if (h < 16) { pool = RECIPES.filter(r => r.c==='Обед'); why = 'Обед.'; }
  else if (h < 21) { pool = RECIPES.filter(r => r.c==='Ужин'); why = t==='rest' ? 'Ужин в дефицитный день: больше белка и овощей, меньше крупы.' : 'Ужин.'; }
  else { pool = RECIPES.filter(r => r.c==='Перекус' || r.c==='После льда'); why = 'Поздно: что-то лёгкое и белковое.'; }
  if (t === 'rest') pool = pool.filter(r => !(r.tags||[]).includes('carb'));
  const fast = pool.filter(r => (r.tags||[]).includes('fast'));
  const pick = (fast.length >= 3 ? fast : pool).sort(() => Math.random()-0.5).slice(0,5);
  openModal('Что съесть сейчас', box => {
    const p = document.createElement('div'); p.className = 'note'; p.style.marginTop = '0'; p.textContent = why;
    box.appendChild(p);
    pick.forEach(r => {
      const el = document.createElement('div'); el.className = 'pick';
      el.innerHTML = '<div><div class="nm"></div><div class="sub">'+r.t+' мин · примерно '+r.k+' ккал</div></div><div class="meta">'+r.p+' г</div>';
      el.querySelector('.nm').textContent = r.n;
      el.onclick = () => { addMeal(r, r.n, r.p); closeModal(); toast('Добавлено'); };
      box.appendChild(el);
    });
  });
}

/* ============ 13. Тренды ============ */
function series(days, pick) {
  return days.map(k => ({ k, v: pick(S.days[k] || {}) })).filter(x => x.v != null);
}
function lastDays(n) { const out = []; const t = todayKey(); for (let i = n-1; i >= 0; i--) out.push(addDays(t, -i)); return out; }
function ma(arr, w) {
  return arr.map((_, i) => {
    const from = Math.max(0, i-w+1), part = arr.slice(from, i+1);
    return part.reduce((s,x) => s+x.v, 0) / part.length;
  });
}
function spark(values, opts) {
  opts = opts || {};
  const W = 600, H = 88, P = 6;
  if (!values.length) return '<svg viewBox="0 0 '+W+' '+H+'"></svg>';
  const min = Math.min.apply(null, values), max = Math.max.apply(null, values);
  const pad = (max-min) || 1;
  const x = i => P + (W-2*P) * (values.length===1 ? .5 : i/(values.length-1));
  const y = v => H-P - (H-2*P) * ((v-min)/(pad));
  let path = values.map((v,i) => (i?'L':'M') + x(i).toFixed(1) + ' ' + y(v).toFixed(1)).join(' ');
  let s = '<svg viewBox="0 0 '+W+' '+H+'" preserveAspectRatio="none">';
  s += '<path d="'+path+' L '+x(values.length-1).toFixed(1)+' '+(H-P)+' L '+x(0).toFixed(1)+' '+(H-P)+' Z" fill="'+(opts.fill||'rgba(59,125,224,.14)')+'"/>';
  s += '<path d="'+path+'" fill="none" stroke="'+(opts.stroke||'#3B7DE0')+'" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>';
  if (opts.dots) values.forEach((v,i) => { s += '<circle cx="'+x(i).toFixed(1)+'" cy="'+y(v).toFixed(1)+'" r="2.5" fill="'+(opts.stroke||'#3B7DE0')+'"/>'; });
  s += '</svg>';
  return s;
}
function bars(values, opts) {
  opts = opts || {};
  const W = 600, H = 88, P = 6, n = values.length;
  if (!n) return '<svg viewBox="0 0 '+W+' '+H+'"></svg>';
  const max = Math.max.apply(null, values.concat([opts.target || 0])) || 1;
  const bw = (W-2*P)/n;
  let s = '<svg viewBox="0 0 '+W+' '+H+'" preserveAspectRatio="none">';
  values.forEach((v,i) => {
    const h = (H-2*P) * (v/max), col = opts.color ? opts.color(v) : '#3B7DE0';
    s += '<rect x="'+(P+i*bw+bw*.16).toFixed(1)+'" y="'+(H-P-h).toFixed(1)+'" width="'+(bw*.68).toFixed(1)+'" height="'+Math.max(1,h).toFixed(1)+'" rx="2" fill="'+col+'"/>';
  });
  if (opts.target) { const ty = H-P-(H-2*P)*(opts.target/max);
    s += '<line x1="'+P+'" y1="'+ty.toFixed(1)+'" x2="'+(W-P)+'" y2="'+ty.toFixed(1)+'" stroke="#F2A93B" stroke-width="1" stroke-dasharray="4 3"/>'; }
  s += '</svg>';
  return s;
}
function card(title, big, sub, svg) {
  return '<div class="chart"><h3>'+title+'</h3><div class="big">'+big+'</div><div class="sub">'+sub+'</div>'+svg+'</div>';
}
function renderTrends() {
  const wrap = document.getElementById('charts');
  let out = '';

  // вес
  const w60 = series(lastDays(60), d => num(d.weight));
  if (w60.length >= 2) {
    const avg = ma(w60, 7);
    const cur = avg[avg.length-1];
    const prevIdx = Math.max(0, avg.length-8);
    const delta = cur - avg[prevIdx];
    const sign = delta > 0 ? 'up' : 'down';
    out += card('Вес, среднее за 7 дней', cur.toFixed(1) + ' кг',
      '<span class="'+sign+'">'+(delta>0?'+':'')+delta.toFixed(2)+' кг</span> за неделю · ориентир −0,3…−0,4',
      spark(avg, { stroke:'#3B7DE0' }));
  } else out += card('Вес', '—', 'Нужно хотя бы два взвешивания', '');

  // талия
  if (S.waist.length) {
    const ws = S.waist.slice().sort((a,b) => a.d < b.d ? -1 : 1);
    const cur = ws[ws.length-1], prev = ws.length > 1 ? ws[ws.length-2] : null;
    const dl = prev ? (cur.cm - prev.cm) : null;
    out += card('Талия', cur.cm.toFixed(1) + ' см',
      (dl != null ? '<span class="'+(dl>0?'up':'down')+'">'+(dl>0?'+':'')+dl.toFixed(1)+' см</span> с прошлого замера · ' : '') + fmtShort(cur.d),
      spark(ws.map(x => x.cm), { stroke:'#4CC38A', fill:'rgba(76,195,138,.14)', dots:true }));
  } else out += card('Талия', '—', 'Первый замер задаёт точку отсчёта', '');

  // сон
  const days14 = lastDays(14);
  const sl = days14.map(k => { const d = S.days[k] || {}; const b = toMin(d.bed), w = toMin(d.wake);
    if (b == null || w == null) return 0; let m = w-b; if (m <= 0) m += 1440; return m/60; });
  const slOk = sl.filter(v => v > 0);
  out += card('Сон, 14 дней', slOk.length ? (slOk.reduce((a,b)=>a+b,0)/slOk.length).toFixed(1) + ' ч' : '—',
    slOk.length ? 'в среднем · заполнено ' + slOk.length + ' из 14' : 'Нет данных',
    bars(sl, { target:7.5, color:v => v === 0 ? '#1A2632' : (v < 6.5 ? '#E23B4C' : '#3B7DE0') }));

  // белок
  const pr = days14.map(k => { const d = S.days[k] || {}; return (d.meals||[]).reduce((s,m) => s+(m.p||0), 0); });
  const prOk = pr.filter(v => v > 0);
  out += card('Белок из меню, 14 дней', prOk.length ? Math.round(prOk.reduce((a,b)=>a+b,0)/prOk.length) + ' г' : '—',
    prOk.length ? 'в среднем · цель 130–160 г' : 'Записывай еду из меню, белок посчитается сам',
    bars(pr, { target:140, color:v => v === 0 ? '#1A2632' : (v < 110 ? '#E23B4C' : '#4CC38A') }));

  // recovery
  if (S.cfg.whoop) {
    const rc = series(lastDays(21), d => num(d.wr));
    if (rc.length >= 2) {
      const avg = rc.reduce((s,x) => s+x.v, 0)/rc.length;
      out += card('Recovery, 21 день', Math.round(avg) + '%', 'в среднем · смотри тренд, а не день',
        spark(rc.map(x => x.v), { stroke:'#F2A93B', fill:'rgba(242,169,59,.13)' }));
    }
  }

  // третий период
  const p3 = series(lastDays(42), d => num(d.p3));
  if (p3.length >= 2) {
    const avg = p3.reduce((s,x) => s+x.v, 0)/p3.length;
    out += card('Третий период', avg.toFixed(1) + ' из 5', 'по ' + p3.length + ' тренировкам и играм',
      spark(p3.map(x => x.v), { stroke:'#E23B4C', fill:'rgba(226,59,76,.13)', dots:true }));
  }

  wrap.innerHTML = out;
  renderWaistTable();
}
function renderWaistTable() {
  const w = document.getElementById('wTable');
  if (!S.waist.length) { w.innerHTML = '<div class="empty">Замеров пока нет.</div>'; return; }
  const ws = S.waist.slice().sort((a,b) => a.d < b.d ? 1 : -1);
  let h = '<table class="tbl"><tr><th>Дата</th><th>Талия</th><th>Δ</th></tr>';
  ws.forEach((x, i) => {
    const prev = ws[i+1];
    const d = prev ? (x.cm - prev.cm) : null;
    h += '<tr><td>'+fmtShort(x.d)+'</td><td>'+x.cm.toFixed(1)+'</td><td>'+(d==null?'—':(d>0?'+':'')+d.toFixed(1))+'</td></tr>';
  });
  w.innerHTML = h + '</table>';
}

/* ============ 14. Отчёт ============ */
const RULE_NAMES = { r_protein:'белок', r_veg:'овощи', r_liquid:'жидкие калории', r_pre:'за 3 ч до льда',
  r_post:'после льда', r_water:'вода с солью', r_move:'движение' };
const TYPE_NAMES = { ice:'лёд', game:'игра', rest:'обычный день' };

function buildReport(from, to) {
  const keys = [];
  for (let k = from; k <= to; k = addDays(k,1)) keys.push(k);
  const filled = keys.filter(hasData);
  let out = '# Дневник: ' + fmtShort(from) + ' — ' + fmtShort(to) + '\n\n## Сводка\n';

  const ws = keys.map(k => num((S.days[k]||{}).weight)).filter(v => v != null);
  out += '- Заполнено дней: ' + filled.length + ' из ' + keys.length + '\n';
  if (ws.length) out += '- Вес: ' + ws[0].toFixed(1) + ' → ' + ws[ws.length-1].toFixed(1) + ' кг, среднее ' + (ws.reduce((a,b)=>a+b,0)/ws.length).toFixed(1) + '\n';
  const wa = S.waist.filter(x => x.d >= from && x.d <= to).sort((a,b) => a.d < b.d ? -1 : 1);
  if (wa.length) out += '- Талия: ' + wa.map(x => x.cm.toFixed(1)).join(' → ') + ' см\n';
  const sl = keys.map(k => { const d = S.days[k]||{}; const b = toMin(d.bed), w = toMin(d.wake);
    if (b==null||w==null) return null; let m = w-b; if (m<=0) m+=1440; return m; }).filter(v => v!=null);
  if (sl.length) out += '- Сон: в среднем ' + hm(Math.round(sl.reduce((a,b)=>a+b,0)/sl.length)) + ' по ' + sl.length + ' ночам\n';
  const pr = keys.map(k => ((S.days[k]||{}).meals||[]).reduce((s,m)=>s+(m.p||0),0)).filter(v => v>0);
  if (pr.length) out += '- Белок из меню: в среднем ' + Math.round(pr.reduce((a,b)=>a+b,0)/pr.length) + ' г\n';
  let rd = 0, rt = 0;
  keys.forEach(k => { if (!hasData(k)) return; const rl = rulesFor(k), d = S.days[k]||{};
    rt += rl.length; rd += rl.filter(r => d.checks && d.checks[r[0]]).length; });
  if (rt) out += '- Правила: ' + Math.round(rd/rt*100) + '% выполнено\n';
  const ice = keys.filter(k => typeOf(k)==='ice' && hasData(k)).length;
  const gm  = keys.filter(k => typeOf(k)==='game' && hasData(k)).length;
  out += '- Лёд: ' + ice + ', игр: ' + gm + '\n';
  const p3 = keys.map(k => num((S.days[k]||{}).p3)).filter(v => v!=null);
  if (p3.length) out += '- Третий период: в среднем ' + (p3.reduce((a,b)=>a+b,0)/p3.length).toFixed(1) + ' из 5\n';

  out += '\n## По дням\n';
  keys.forEach(k => {
    const d = S.days[k];
    if (!hasData(k)) { out += '\n### ' + fmtLong(k) + ' — не заполнен\n'; return; }
    out += '\n### ' + fmtLong(k) + ' — ' + TYPE_NAMES[typeOf(k)] + '\n';
    const line = [];
    if (d.weight) line.push('вес ' + d.weight);
    const b = toMin(d.bed), w = toMin(d.wake);
    if (b != null && w != null) { let m = w-b; if (m<=0) m+=1440; line.push('сон ' + hm(m) + ' (' + d.bed + ' → ' + d.wake + ')'); }
    if (d.wr || d.ws || d.wh) line.push('whoop ' + [d.wr||'—', d.ws||'—', d.wh||'—'].join('/'));
    if (line.length) out += line.join(' · ') + '\n';
    if (d.meals && d.meals.length) {
      const tot = d.meals.reduce((s,m)=>s+(m.p||0),0);
      out += 'Еда' + (tot ? ' (белок ≈ ' + tot + ' г)' : '') + ':\n';
      d.meals.slice().sort((a,b)=>(a.t||'').localeCompare(b.t||'')).forEach(m => {
        out += '- ' + (m.t||'??:??') + ' ' + m.n + (m.p ? ' (' + m.p + ' г белка)' : '') + '\n';
      });
    }
    const rl = rulesFor(k);
    out += 'Правила: ' + rl.map(r => RULE_NAMES[r[0]] + ' ' + ((d.checks && d.checks[r[0]]) ? 'да' : 'нет')).join(', ') + '\n';
    const st = [];
    if (d.p3) st.push('третий период ' + d.p3 + '/5');
    if (d.feel) st.push('самочувствие ' + d.feel + '/5');
    if (S.cfg.kcal && d.kcal) st.push(d.kcal + ' ккал');
    if (S.cfg.kcal && d.prot) st.push('белок ' + d.prot + ' г');
    if (st.length) out += st.join(' · ') + '\n';
    if (d.note) out += 'Заметка: ' + d.note + '\n';
  });
  return out;
}
function refreshReport() {
  const from = document.getElementById('rFrom').value, to = document.getElementById('rTo').value;
  if (!from || !to || from > to) { document.getElementById('rOut').textContent = 'Выбери период.'; return; }
  document.getElementById('rOut').textContent = buildReport(from, to);
}
const PERIODS = [['Сегодня',0],['3 дня',2],['Неделя',6],['2 недели',13],['Месяц',29]];
function renderPeriodChips() {
  const w = document.getElementById('perChips'); w.innerHTML = '';
  PERIODS.forEach(([label, back]) => {
    const b = document.createElement('button'); b.className = 'chip'; b.textContent = label;
    b.onclick = () => {
      const t = todayKey();
      document.getElementById('rTo').value = t;
      document.getElementById('rFrom').value = addDays(t, -back);
      w.querySelectorAll('.chip').forEach(c => c.classList.remove('on'));
      b.classList.add('on');
      refreshReport();
    };
    w.appendChild(b);
  });
}
function download(name, text, type) {
  const blob = new Blob([text], { type: type || 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
async function copyText(t) {
  try { await navigator.clipboard.writeText(t); toast('Скопировано'); }
  catch (e) {
    const ta = document.createElement('textarea'); ta.value = t;
    ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); toast('Скопировано'); }
    catch (e2) { toast('Скопируй вручную из поля ниже'); }
    ta.remove();
  }
}

/* ============ 15. Синхронизация: интерфейс ============ */
function renderSync() {
  const box = document.getElementById('syncBox');
  if (AUTH && AUTH.access) {
    box.innerHTML = (authBroken ? '<div class="calc" style="color:#E23B4C">Сессия истекла. Нажми «Выйти» и подключись заново — записи на устройстве не пострадают.</div>' : '')
      + '<div class="calc">Вход выполнен: <b>'+AUTH.email+'</b></div>'
      + '<div class="addrow"><button class="btn primary" id="sNow">Синхронизировать сейчас</button><button class="btn" id="sOut">Выйти</button></div>'
      + '<div class="addrow"><button class="btn" id="sAll">Отправить всё с этого устройства</button></div>'
      + '<div class="note">Записи уходят на сервер автоматически через пару секунд после изменения и подтягиваются при открытии приложения. Без интернета всё продолжает работать локально.<br><br>«Отправить всё» нужна редко: когда на сервере оказалась версия хуже, чем на этом устройстве. Она перезапишет серверные записи местными.</div>';
    document.getElementById('sNow').onclick = () => syncNow();
    document.getElementById('sAll').onclick = async () => {
      if (!confirm('Отправить все записи с этого устройства на сервер? Серверные версии этих дней будут заменены.')) return;
      Object.keys(S.days).filter(hasData).forEach(k => { S.days[k].u = Date.now(); });
      S.waist.forEach(w => { w.u = Date.now(); });
      (S.custom || []).forEach(c => { c.u = Date.now(); });
      S.cfg.u = Date.now();
      pushEverything(); store.set(LS, JSON.stringify(S));
      await syncNow(); toast('Отправлено');
    };
    document.getElementById('sOut').onclick = () => { if (confirm('Выйти? Записи на устройстве останутся.')) { logout(); renderSync(); badge('только на устройстве',''); } };
    return;
  }
  box.innerHTML =
    '<div class="note" style="margin-top:0">Пока данные живут только в этом браузере. Подключи базу — и телефон с ноутбуком будут видеть одно и то же. Ключи берутся в Supabase: Settings → API.</div>'
    + '<div class="f" style="margin-top:12px"><span>Project URL</span><input type="text" id="sUrl" placeholder="https://xxxx.supabase.co" autocomplete="off"></div>'
    + '<div class="f" style="margin-top:9px"><span>Anon key</span><input type="text" id="sKey" placeholder="eyJ..." autocomplete="off"></div>'
    + '<div class="f" style="margin-top:9px"><span>Почта</span><input type="email" id="sMail" autocomplete="username"></div>'
    + '<div class="f" style="margin-top:9px"><span>Пароль</span><input type="password" id="sPw" autocomplete="current-password"></div>'
    + '<div class="addrow"><button class="btn primary" id="sIn">Подключить</button></div>';
  document.getElementById('sIn').onclick = async () => {
    const url = document.getElementById('sUrl').value.trim();
    const key = document.getElementById('sKey').value.trim();
    const mail = document.getElementById('sMail').value.trim();
    const pw = document.getElementById('sPw').value;
    if (!url || !key || !mail || !pw) { toast('Заполни все четыре поля'); return; }
    try {
      await login(url, key, mail, pw);
      pushEverything();
      renderSync(); toast('Подключено');
      await syncNow(true);
    } catch (e) { toast(e.message); }
  };
}

/* ============ 16. Инициализация ============ */
function renderAll() { renderWeek(); renderDay(); renderTrends(); }

function bind() {
  // поля дня
  document.querySelectorAll('[data-k]').forEach(el => {
    const f = el.dataset.k;
    const isNum = el.classList.contains('num') || el.type === 'number';
    const write = () => {
      const d = day(sel);
      d[f] = isNum ? dec(el.value) : el.value;
      touch(sel, f);
    };
    el.addEventListener('input', () => { write(); renderWeek(); });
    el.addEventListener('change', () => {
      write();
      if (isNum) el.value = day(sel)[f];                     // 79,4 показываем как 79.4
      if (f === 'weight') renderWeightDelta(sel);
      if (f === 'bed' || f === 'wake' || f === 'start') renderDay();
      renderWeek();
    });
  });

  document.getElementById('prevW').onclick = () => { anchor.setDate(anchor.getDate()-7); renderWeek(); };
  document.getElementById('nextW').onclick = () => { anchor.setDate(anchor.getDate()+7); renderWeek(); };
  document.getElementById('addMeal').onclick = mealPicker;
  document.getElementById('suggestBtn').onclick = suggest;
  document.getElementById('mClose').onclick = closeModal;
  document.getElementById('modal').onclick = e => { if (e.target.id === 'modal') closeModal(); };

  document.querySelectorAll('.tabs button').forEach(b => {
    b.onclick = () => {
      document.querySelectorAll('.tabs button').forEach(x => x.classList.remove('on'));
      document.querySelectorAll('.pane').forEach(x => x.classList.remove('on'));
      b.classList.add('on');
      document.getElementById('p-' + b.dataset.p).classList.add('on');
      if (b.dataset.p === 'trend') renderTrends();
      if (b.dataset.p === 'more') { renderSync(); refreshReport(); }
      window.scrollTo(0,0);
    };
  });

  const q = document.getElementById('q');
  q.oninput = () => { query = q.value; renderFood(); };

  // талия
  document.getElementById('wAdd').onclick = () => {
    const d = document.getElementById('wDate').value, cm = num(document.getElementById('wCm').value);
    if (!d || cm == null) { toast('Нужны дата и сантиметры'); return; }
    const i = S.waist.findIndex(x => x.d === d);
    const rec = { d, cm, u: Date.now() };
    if (i >= 0) S.waist[i] = rec; else S.waist.push(rec);
    S.waist.sort((a,b) => a.d < b.d ? 1 : -1);
    saveLocal('waist:' + d);
    document.getElementById('wCm').value = '';
    renderTrends(); toast('Замер записан');
  };

  // отчёт
  document.getElementById('rFrom').onchange = refreshReport;
  document.getElementById('rTo').onchange = refreshReport;
  document.getElementById('rCopy').onclick = () => copyText(document.getElementById('rOut').textContent);
  document.getElementById('rDl').onclick = () => {
    const f = document.getElementById('rFrom').value, t = document.getElementById('rTo').value;
    download(APP_NAME.toLowerCase() + '-' + f + '_' + t + '.md', document.getElementById('rOut').textContent, 'text/markdown;charset=utf-8');
  };

  // настройки
  const tue = document.getElementById('cfgTue'), fri = document.getElementById('cfgFri');
  const cfgSave = () => { S.cfg.u = Date.now(); saveLocal('cfg:main'); };
  tue.onchange = () => { S.cfg.ice['2'] = tue.value; cfgSave(); renderDay(); };
  fri.onchange = () => { S.cfg.ice['5'] = fri.value; cfgSave(); renderDay(); };
  const cw = document.getElementById('cfgWhoop'), ck = document.getElementById('cfgKcal');
  cw.onchange = () => { S.cfg.whoop = cw.checked; cfgSave(); renderDay(); renderTrends(); };
  ck.onchange = () => { S.cfg.kcal = ck.checked; cfgSave(); renderDay(); };

  // данные
  document.getElementById('expBtn').onclick = () =>
    download(APP_NAME.toLowerCase() + '-' + todayKey() + '.json', JSON.stringify(S, null, 1), 'application/json');
  document.getElementById('impBtn').onclick = () => document.getElementById('impFile').click();
  document.getElementById('impFile').onchange = e => {
    const f = e.target.files[0]; if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      try {
        const j = JSON.parse(r.result);
        if (!j.days) throw new Error();
        if (!confirm('Заменить текущие записи содержимым файла?')) return;
        S = { days: j.days || {}, waist: j.waist || [], custom: j.custom || [],
              cfg: Object.assign({}, DEF_CFG, j.cfg || {}) };
        pushEverything();
        saveLocal(); renderAll(); fillSettings(); toast('Загружено');
      } catch (err) { toast('Файл не подошёл'); }
    };
    r.readAsText(f);
    e.target.value = '';
  };
  document.getElementById('wipeBtn').onclick = () => {
    if (!confirm('Удалить все записи на этом устройстве? Отменить будет нельзя.')) return;
    Object.keys(S.days).filter(hasData).forEach(k => dirty.add('day:'+k));
    S.waist.forEach(w => dirty.add('waist:'+w.d));
    (S.custom || []).forEach(c => dirty.add('custom:'+c.id));
    S = { days:{}, waist:[], custom:[], cfg:Object.assign({}, DEF_CFG) };
    store.set(LS_DIRTY, JSON.stringify([...dirty]));
    saveLocal(); renderAll(); toast('Удалено');
  };

  document.addEventListener('visibilitychange', () => { if (!document.hidden) syncNow(true); });
  window.addEventListener('online', () => syncNow(true));

  // Лента считает ширину в пикселях, поэтому при повороте экрана её надо пересобрать.
  let rsT = null;
  window.addEventListener('resize', () => { clearTimeout(rsT); rsT = setTimeout(() => renderTimeline(sel), 150); });
}
function fillSettings() {
  const v = document.getElementById('verNote');
  if (v) v.textContent = 'Версия приложения: ' + APP_VERSION;
  document.getElementById('cfgTue').value = S.cfg.ice['2'] || '22:30';
  document.getElementById('cfgFri').value = S.cfg.ice['5'] || '21:00';
  document.getElementById('cfgWhoop').checked = !!S.cfg.whoop;
  document.getElementById('cfgKcal').checked = !!S.cfg.kcal;
}

(function init() {
  const h1 = document.getElementById('appName');
  if (h1) h1.textContent = APP_NAME;
  loadLocal();
  bind();
  fillSettings();
  renderChips(); renderFood(); renderGuide();
  renderPeriodChips();
  const t = todayKey();
  document.getElementById('wDate').value = t;
  document.getElementById('rTo').value = t;
  document.getElementById('rFrom').value = addDays(t, -6);
  renderAll();
  refreshReport();
  if (store.get('rink-gen') !== '2') { store.del(LS_PULL); store.set('rink-gen', '2'); }
  if (AUTH && AUTH.access) { badge('синхронизировано','ok'); syncNow(true); }
  if ('serviceWorker' in navigator) {
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloaded) return; reloaded = true; location.reload();   // подхватить новую версию сразу
    });
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();

})();

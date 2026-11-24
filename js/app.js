import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import * as CONFIG from './config.js';
const { SUPABASE_URL, SUPABASE_ANON_KEY, LOGIN_DOMAIN } = CONFIG;
const CSE_ID = String(CONFIG.GOOGLE_CSE_ID || '').trim(); // buscador seguro de Google (opcional)

// =====================================================================
// CONFIGURACIÓN Y UTILIDADES
// =====================================================================
const BUCKET = 'tareas-escolares';
const ADMIN_FN = 'gestionar-alumnas';
const MAX_FILE = 20 * 1024 * 1024;
// Formatos permitidos y su tipo (para que el archivo se guarde con el tipo correcto)
const MIME = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  accdb: 'application/vnd.ms-access', mdb: 'application/vnd.ms-access',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  txt: 'text/plain', zip: 'application/zip',
};
const ALLOWED_EXT = Object.keys(MIME);
const mimeFor = (name) => MIME[(name.split('.').pop() || '').toLowerCase()] || 'application/octet-stream';
const TIPOS = { tarea: 'Tarea', proyecto: 'Proyecto', practica: 'Práctica', investigacion: 'Investigación', exposicion: 'Exposición' };

const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (x) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[x]));
const fmt = (s) => (s ? new Intl.DateTimeFormat('es-GT', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(s)) : 'Sin fecha');
const cap = (x) => x.charAt(0).toUpperCase() + x.slice(1);
const today = cap(new Intl.DateTimeFormat('es-GT', { dateStyle: 'full' }).format(new Date()));
const setupDone = SUPABASE_URL.startsWith('https://') && !SUPABASE_URL.includes('TU-PROYECTO') && !SUPABASE_ANON_KEY.startsWith('TU_');
const db = setupDone ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;
// Supabase rechaza direcciones muy largas ("Bad Request") cuando se piden
// cientos de ids juntos. Esto parte la lista en grupos de 80 y une el resultado.
const IN_CHUNK = 80;
async function inChunks(ids, build, sortFn = null, size = IN_CHUNK) {
  const list = [...new Set(ids)];
  if (!list.length) return { data: [], error: null };
  const parts = [];
  for (let i = 0; i < list.length; i += size) parts.push(list.slice(i, i + size));
  const results = await Promise.all(parts.map((p) => build(p)));
  const bad = results.find((r) => r.error);
  if (bad) return { data: null, error: bad.error };
  const data = results.flatMap((r) => r.data || []);
  if (sortFn) data.sort(sortFn);
  return { data, error: null };
}
const byDate = (col, desc = false) => (a, b) => (desc ? -1 : 1) * (new Date(a[col]) - new Date(b[col]));

const modal = (id) => bootstrap.Modal.getOrCreateInstance($(id));

// Estado
let me = null;
let courses = [], tasks = [], submissions = [], grades = [], notices = [], enrollments = [], files = [], materials = [];
let view = 'inicio', viewArg = null, renderToken = 0;
let submittingTask = null, gradingSubmission = null, studentsCourse = null;
let hasV4 = true;                 // ¿ya se ejecutó migracion-v4 (clave y foto)?
let hasV5 = true;                 // ¿ya se ejecutó migracion-v5 (grupos, exposición, portadas)?
let groups = [], members = [];    // grupos y sus integrantes
let studentsTab = 'lista', studentsSort = 'clave';
let editingGroup = null;
let choosingCourse = null;
let entregasTab = 'resumen', dashCourse = '', dashBin = null;
// v7: material de lectura, consultas y agenda
let hasV7 = true;
let readings = [], readingFiles = [], queries = [], queryMsgs = [];
let materialCourse = '', queriesTab = 'abiertas';
let agendaMode = 'mes', agendaRef = new Date(), agendaDay = null, agendaCourse = '', miniRef = new Date();
const hasV6 = (c) => c && 'grupos_abiertos' in c;  // ¿ya se ejecutó migracion-v6?
const COVER_BUCKET = 'portadas-cursos';
const photoUrls = new Map();      // ruta de foto → enlace firmado
const PHOTO_BUCKET = 'fotos-perfil';

function notify(message, kind = 'success', delay = 4500) {
  const el = document.createElement('div');
  el.className = `toast align-items-center text-bg-${kind} border-0`;
  el.setAttribute('role', 'alert');
  el.innerHTML = `<div class="d-flex"><div class="toast-body">${esc(message)}</div><button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast"></button></div>`;
  $('#toastHost').append(el);
  const t = new bootstrap.Toast(el, { delay });
  el.addEventListener('hidden.bs.toast', () => el.remove());
  t.show();
}
function loading() { $('#mainContent').innerHTML = '<div class="py-5 text-center"><div class="spinner-border text-primary"></div></div>'; }
function safeHttpUrl(value) { try { const u = new URL(value); return ['https:', 'http:'].includes(u.protocol) ? u.href : null; } catch { return null; } }
function empty(message = 'Todavía no hay información para mostrar.') { return `<div class="empty-state"><i class="bi bi-folder2-open"></i><p class="mt-3 mb-0">${esc(message)}</p></div>`; }
function badge(text, cls = 'pill-purple') { return `<span class="badge-soft ${cls}">${esc(text)}</span>`; }
function stat(label, value, icon, pill) { return `<div class="col-sm-6 col-xl-3"><div class="stat-card h-100"><div class="stat-icon ${pill}"><i class="bi bi-${icon}"></i></div><h3>${esc(value)}</h3><div class="stat-label">${esc(label)}</div></div></div>`; }
function greeting() { const h = new Date().getHours(); return h < 12 ? 'Buenos días' : h < 18 ? 'Buenas tardes' : 'Buenas noches'; }
function setTitle(t, small = 'Mi espacio') { $('#pageTitle').textContent = t; $('#topBreadcrumb').textContent = small; }
function pre(text) { return `<p class="mb-0" style="white-space:pre-wrap">${esc(text)}</p>`; }

const isTeacher = () => me?.rol === 'docente';
const fullName = (u) => (u ? `${u.nombre} ${u.apellido}` : 'Alumna');
const course = (id) => courses.find((c) => c.id === id);
const courseName = (id) => course(id)?.nombre || 'Curso';
const task = (id) => tasks.find((t) => t.id === id);
const mySubmission = (taskId) => submissions.find((s) => s.tarea_id === taskId && s.alumna_id === me.id);
const gradeFor = (subId) => grades.find((g) => g.entrega_id === subId);
const filesFor = (subId) => files.filter((f) => f.entrega_id === subId);
const materialsFor = (taskId) => materials.filter((m) => m.tarea_id === taskId);
const listName = (u) => (u ? `${u.apellido}, ${u.nombre}` : 'Alumna');
const byClave = (a, b) => (a?.clave ?? 9999) - (b?.clave ?? 9999) || listName(a).localeCompare(listName(b), 'es');
const studentsOf = (courseId) => enrollments.filter((e) => e.curso_id === courseId)
  .sort((a, b) => byClave(a.usuarios, b.usuarios));
const isExpired = (t) => new Date(t.fecha_limite) < new Date();
const isExpo = (t) => t?.tipo === 'exposicion';
const isGroupTask = (t) => hasV5 && t?.modalidad === 'grupal';
const groupsOf = (courseId) => groups.filter((g) => g.curso_id === courseId).sort((a, b) => a.nombre.localeCompare(b.nombre, 'es', { numeric: true }));
const membersOf = (groupId) => members.filter((m) => m.grupo_id === groupId).sort((a, b) => byClave(a.usuarios, b.usuarios));
const groupOf = (alumnaId, courseId) => { const m = members.find((x) => x.alumna_id === alumnaId && x.curso_id === courseId); return m ? groups.find((g) => g.id === m.grupo_id) : null; };
const submissionOf = (taskId, alumnaId) => submissions.find((s) => s.tarea_id === taskId && s.alumna_id === alumnaId);
const hasWork = (s) => !!(s && (s.contenido || s.enlace || filesFor(s.id).length));
// Nota acumulada: tareas calificadas + tareas vencidas sin entregar (cuentan 0).
// Las entregadas que aún no calificas no cuentan todavía.
function accumulated(alumnaId, courseId) {
  let earned = 0, possible = 0, graded = 0;
  for (const t of tasks) {
    if (t.curso_id !== courseId || !t.publicada) continue;
    const s = submissionOf(t.id, alumnaId);
    const g = s && gradeFor(s.id);
    if (g) { earned += Number(g.nota); possible += Number(t.puntos_maximos); graded++; }
    else if (isExpired(t) && !hasWork(s) && !isExpo(t)) possible += Number(t.puntos_maximos);
  }
  return { earned, possible, graded, pct: possible ? (earned / possible) * 100 : null };
}
const num = (n) => (Math.round(n * 100) / 100).toLocaleString('es-GT');
function accHtml(a, big = false) {
  if (a.pct === null) return '<span class="muted">—</span>';
  const cls = a.pct >= 80 ? 'acc-good' : a.pct >= 60 ? 'acc-mid' : 'acc-low';
  return big
    ? `<div class="acc-big ${cls}">${Math.round(a.pct)}%</div><div class="small muted">${num(a.earned)} de ${num(a.possible)} puntos</div>`
    : `<span class="acc ${cls}">${Math.round(a.pct)}%</span> <span class="small muted">${num(a.earned)}/${num(a.possible)}</span>`;
}
const isLate = (s) => { const t = task(s.tarea_id); return t && new Date(s.fecha_entrega) > new Date(t.fecha_limite); };
const tipoBadge = (t) => badge(TIPOS[t.tipo] || 'Tarea', 'pill-blue');
function studentName(id) {
  const u = enrollments.find((e) => e.alumna_id === id)?.usuarios || submissions.find((s) => s.alumna_id === id)?.usuarios;
  return fullName(u);
}
function canSubmit(t) {
  const s = mySubmission(t.id);
  if (s && gradeFor(s.id)) return false;
  return t.permite_entrega_tardia || !isExpired(t);
}
function statusFor(t) {
  const s = mySubmission(t.id);
  const g = s && gradeFor(s.id);
  if (g) return badge(`${g.nota} / ${t.puntos_maximos} pts`, 'pill-green');
  if (hasWork(s)) return badge('Entregada', 'pill-purple');
  if (isGroupTask(t)) {
    const grp = groupOf(me.id, t.curso_id);
    if (grp && membersOf(grp.id).some((m) => hasWork(submissionOf(t.id, m.alumna_id)))) return badge('Entregada por tu grupo', 'pill-purple');
  }
  return isExpired(t) ? badge('Sin entregar', 'pill-orange') : badge('Pendiente', 'pill-blue');
}
function toLocalInput(iso) {
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
const fileExt = (name) => (name.split('.').pop() || '').toLowerCase();
const safeName = (n) => n.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-100);
function checkFiles(list) {
  for (const f of list) {
    if (f.size > MAX_FILE) return `"${f.name}" supera los 20 MB.`;
    if (!ALLOWED_EXT.includes(fileExt(f.name))) return `"${f.name}" tiene un formato no permitido.`;
  }
  return null;
}
function generatePassword() {
  const words = ['luna', 'sol', 'rio', 'flor', 'mar', 'nube', 'pino', 'lago', 'cielo', 'roca'];
  const n = crypto.getRandomValues(new Uint32Array(2));
  return `${words[n[0] % words.length]}${1000 + (n[1] % 9000)}`;
}
async function busy(btn, fn) {
  if (btn) btn.disabled = true;
  try { return await fn(); } finally { if (btn) btn.disabled = false; }
}
function errMsg(error) {
  const m = error?.message || String(error);
  // Mensajes de RAISE EXCEPTION llegan tal cual
  return m;
}

// Lista de archivos con enlaces firmados (5 minutos)
async function fileListHtml(list, deleteAttr = null, emptyText = 'Sin archivos adjuntos') {
  if (!list.length) return `<span class="muted small">${esc(emptyText)}</span>`;
  const { data } = await db.storage.from(BUCKET).createSignedUrls(list.map((f) => f.ruta_storage), 300);
  return `<div class="file-list">${list.map((f) => {
    const url = data?.find((d) => d.path === f.ruta_storage)?.signedUrl;
    const name = esc(f.nombre_archivo);
    const link = url
      ? `<a target="_blank" rel="noopener noreferrer" href="${esc(url)}"><i class="bi bi-paperclip"></i> ${name}</a>`
      : `<span><i class="bi bi-paperclip"></i> ${name}</span>`;
    const del = deleteAttr ? `<button type="button" class="btn btn-sm btn-link text-danger p-0 ms-auto" ${deleteAttr}="${esc(f.id)}" title="Quitar archivo"><i class="bi bi-trash"></i></button>` : '';
    return `<div class="file-chip">${link}${del}</div>`;
  }).join('')}</div>`;
}

// Llamada a la Edge Function (crear cuentas / contraseñas)
async function callAdmin(body) {
  const { data, error } = await db.functions.invoke(ADMIN_FN, { body });
  if (error) {
    let msg = error.message;
    try { const j = await error.context.json(); if (j?.error) msg = j.error; } catch { /* sin cuerpo */ }
    if (/Failed to send|Failed to fetch|not found/i.test(msg)) msg = 'No se pudo contactar la función "gestionar-alumnas". ¿Ya la publicaste en Supabase > Edge Functions?';
    throw new Error(msg);
  }
  if (data?.error) throw new Error(data.error);
  return data;
}

// Fotos de perfil (bucket privado, enlaces firmados de 1 hora)
async function loadPhotos(users) {
  if (!hasV4) return;
  const paths = [...new Set(users.map((u) => u?.foto).filter((p) => p && !photoUrls.has(p)))];
  if (!paths.length) return;
  const { data } = await db.storage.from(PHOTO_BUCKET).createSignedUrls(paths, 3600);
  for (const d of data || []) if (d.signedUrl) photoUrls.set(d.path, d.signedUrl);
}
async function loadCovers(list) {
  if (!hasV5) return;
  const paths = [...new Set(list.map((c) => c.portada).filter((p) => p && !photoUrls.has(p)))];
  if (!paths.length) return;
  const { data } = await db.storage.from(COVER_BUCKET).createSignedUrls(paths, 3600);
  for (const d of data || []) if (d.signedUrl) photoUrls.set(d.path, d.signedUrl);
}
function avatarHtml(u, cls = 'avatar avatar-sm') {
  const url = u?.foto && photoUrls.get(u.foto);
  return url
    ? `<span class="${cls} avatar-photo"><img src="${esc(url)}" alt=""></span>`
    : `<span class="${cls}">${esc((u?.nombre || '?').charAt(0).toUpperCase())}</span>`;
}
function paintMyAvatar() {
  const url = me?.foto && photoUrls.get(me.foto);
  for (const el of [$('#sidebarInitial'), $('#topInitial'), $('#profilePhoto')]) {
    el.classList.toggle('avatar-photo', !!url);
    el.innerHTML = url ? `<img src="${esc(url)}" alt="">` : esc(me.nombre.charAt(0).toUpperCase());
  }
}
// Recorta al centro con la proporción w:h y reduce el tamaño
async function resizeImage(file, w = 256, h = w) {
  const bmp = await createImageBitmap(file);
  const ratio = w / h;
  let sw = bmp.width, sh = bmp.width / ratio;
  if (sh > bmp.height) { sh = bmp.height; sw = sh * ratio; }
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  canvas.getContext('2d').drawImage(bmp, (bmp.width - sw) / 2, (bmp.height - sh) / 2, sw, sh, 0, 0, w, h);
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
}

// =====================================================================
// SESIÓN Y DATOS
// =====================================================================
function showApp() {
  $('#loginScreen').classList.add('d-none');
  $('#appShell').classList.remove('d-none');
  $('#sidebarName').textContent = fullName(me);
  $('#sidebarRole').textContent = isTeacher() ? 'Docente' : 'Alumna';
  paintMyAvatar();
  $('#todayLabel').textContent = today;
  document.querySelectorAll('[data-teacher-only]').forEach((el) => el.classList.toggle('d-none', !isTeacher()));
}
function showLogin() { $('#appShell').classList.add('d-none'); $('#loginScreen').classList.remove('d-none'); $('#password').value = ''; }

async function restore() {
  if (!db) { $('#configAlert').classList.remove('d-none'); return; }
  const { data: { session } } = await db.auth.getSession();
  if (session) await loadProfile(session.user.id);
}
async function loadProfile(id) {
  let { data, error } = await db.from('usuarios').select('id,usuario,nombre,apellido,rol,activo,clave,foto').eq('id', id).single();
  if (error && /clave|foto|column/i.test(error.message)) {
    // Aún no se ejecutó migracion-v4: seguir sin clave ni foto
    hasV4 = false;
    ({ data, error } = await db.from('usuarios').select('id,usuario,nombre,apellido,rol,activo').eq('id', id).single());
  }
  if (error || !data || !data.activo) {
    await db.auth.signOut(); showLogin();
    notify('Tu cuenta no tiene perfil activo. Consulta a tu docente.', 'warning');
    return;
  }
  me = data; view = 'inicio'; viewArg = null;
  await loadPhotos([me]);
  showApp();
  await refresh();
}

async function refresh(quiet = false) {
  if (!quiet) loading();
  try {
    let q = db.from('cursos').select('*').eq('activo', true).order('nombre');
    if (isTeacher()) q = q.eq('docente_id', me.id);
    const cr = await q;
    if (cr.error) throw cr.error;
    courses = cr.data || [];
    tasks = []; submissions = []; grades = []; notices = []; enrollments = []; files = []; materials = []; groups = []; members = [];
    readings = []; readingFiles = []; queries = []; queryMsgs = [];
    const ids = courses.map((c) => c.id);
    await loadCovers(courses);

    if (ids.length) {
      const [tr, nr, er] = await Promise.all([
        db.from('tareas').select('*').in('curso_id', ids).order('fecha_limite', { ascending: true }),
        db.from('anuncios').select('*').in('curso_id', ids).order('creado_en', { ascending: false }),
        db.from('inscripciones').select(`id,curso_id,alumna_id,usuarios:alumna_id(id,usuario,nombre,apellido${hasV4 ? ',clave,foto' : ''})`).in('curso_id', ids),
      ]);
      for (const r of [tr, nr, er]) if (r.error) throw r.error;
      tasks = tr.data || []; notices = nr.data || []; enrollments = er.data || [];

      if (hasV5) {
        const [gq, mq] = await Promise.all([
          db.from('grupos').select('*').in('curso_id', ids),
          db.from('grupo_integrantes').select(`id,grupo_id,curso_id,alumna_id,usuarios:alumna_id(id,usuario,nombre,apellido${hasV4 ? ',clave,foto' : ''})`).in('curso_id', ids),
        ]);
        if (gq.error || mq.error) {
          hasV5 = false;
          console.warn('Grupos no disponibles (¿falta migracion-v5?):', (gq.error || mq.error).message);
        } else { groups = gq.data || []; members = mq.data || []; }
      }

      if (hasV7) await loadV7(ids);

      const taskIds = tasks.map((t) => t.id);
      if (taskIds.length) {
        const onlyMine = !isTeacher() && !hasV5; // con v5, la alumna también ve la entrega de su grupo
        const [sr, mr] = await Promise.all([
          inChunks(taskIds, (p) => {
            let q = db.from('entregas').select('*, usuarios:alumna_id(nombre,apellido,usuario)').in('tarea_id', p);
            return onlyMine ? q.eq('alumna_id', me.id) : q;
          }, byDate('fecha_entrega', true), 10), // 10 tareas por consulta: así no se pasa de 1000 filas
          inChunks(taskIds, (p) => db.from('archivos_tarea').select('*').in('tarea_id', p), byDate('creado_en')),
        ]);
        if (sr.error) throw sr.error;
        submissions = sr.data || [];
        if (mr.error) console.warn('archivos_tarea no disponible (¿falta migracion-v3.sql?):', mr.error.message);
        else materials = mr.data || [];

        const subIds = submissions.map((s) => s.id);
        if (subIds.length) {
          const [gr, fr] = await Promise.all([
            inChunks(subIds, (p) => db.from('calificaciones').select('*').in('entrega_id', p)),
            inChunks(subIds, (p) => db.from('archivos_entrega').select('*').in('entrega_id', p), byDate('creado_en')),
          ]);
          if (gr.error) throw gr.error;
          if (fr.error) throw fr.error;
          grades = gr.data || []; files = fr.data || [];
        }
      }
    }
    await render();
  } catch (err) {
    console.error(err);
    $('#mainContent').innerHTML = `<div class="alert alert-danger">No se pudieron cargar los datos. ${esc(err.message)}. Comprueba las políticas RLS y la conexión.</div>`;
  }
}

// =====================================================================
// NAVEGACIÓN Y VISTAS
// =====================================================================
function navigate(v, arg = null) {
  view = v; viewArg = arg;
  const navKey = { tarea: 'tareas', entrega: 'entregas', consulta: 'consultas' }[v] || v;
  document.querySelectorAll('#sideNav .nav-link').forEach((x) => x.classList.toggle('active', x.dataset.view === navKey));
  $('#sidebar').classList.remove('open');
  $('#mobileShade').classList.add('d-none');
  render();
  window.scrollTo(0, 0);
}
function render() {
  if (!me) return;
  renderToken++;
  const navKey = { tarea: 'tareas', entrega: 'entregas', consulta: 'consultas' }[view] || view;
  document.querySelectorAll('#sideNav .nav-link').forEach((x) => x.classList.toggle('active', x.dataset.view === navKey));
  const views = {
    inicio: renderHome, cursos: renderCourses, tareas: () => renderTasks(viewArg), tarea: () => renderTaskDetail(viewArg),
    entregas: renderSubmissions, entrega: () => renderSubmissionDetail(viewArg), alumnas: renderStudents, anuncios: renderNotices,
    agenda: renderAgenda, buscar: renderSearch, respaldo: renderBackup, material: renderMaterial, consultas: renderQueries, consulta: () => renderQueryDetail(viewArg), compartido: renderShared,
  };
  paintQueryBadge();
  return (views[view] || renderHome)();
}

function courseCard(c) {
  const teacher = isTeacher();
  const nStudents = studentsOf(c.id).length;
  const nTasks = tasks.filter((t) => t.curso_id === c.id).length;
  const code = teacher && c.codigo_clase
    ? `<div class="class-code mb-3"><span class="small muted">Código de clase</span><strong>${esc(c.codigo_clase)}</strong><button class="btn btn-sm btn-link p-0" data-copy-code="${esc(c.codigo_clase)}" title="Copiar código"><i class="bi bi-copy"></i></button></div>`
    : '';
  const cover = c.portada && photoUrls.get(c.portada);
  const top = cover
    ? `<div class="course-cover" style="background-image:url('${esc(cover)}')"></div>`
    : '<div class="course-bar"></div>';
  const mine = !teacher ? accumulated(me.id, c.id) : null;
  const myGroup = !teacher && hasV5 ? groupOf(me.id, c.id) : null;
  const canChoose = !teacher && hasV5 && hasV6(c) && c.grupos_abiertos;
  const studentInfo = mine
    ? `<div class="acc-box mb-3"><div><div class="small muted">Tu nota acumulada</div>${accHtml(mine)}</div>${myGroup || canChoose ? `<div class="text-end"><div class="small muted">Tu grupo</div><strong>${myGroup ? esc(myGroup.nombre) : '<span class="text-warning">Sin grupo</span>'}</strong>${canChoose ? `<div><button class="btn btn-link btn-sm p-0" data-choose-group="${esc(c.id)}">${myGroup ? 'Cambiar' : 'Elegir grupo'}</button></div>` : ''}</div>` : ''}</div>`
    : '';
  return `<div class="col-md-6 col-xl-4"><div class="course-card h-100">${top}<div class="course-content">
    ${cover ? '' : '<div class="course-symbol mb-3"><i class="bi bi-journal-bookmark"></i></div>'}
    <h5 class="fw-bold mb-1">${esc(c.nombre)}</h5>
    <p class="muted mb-2">${esc(c.grado)} · Sección ${esc(c.seccion)} · ${esc(c.ciclo_escolar)}</p>
    <p class="text-muted small mb-3">${esc(c.descripcion || 'Espacio de actividades y aprendizaje.')}</p>
    ${code}${studentInfo}
    <div class="d-flex flex-wrap gap-2">
      <button class="btn btn-outline-primary btn-sm" data-open-course="${esc(c.id)}">Tareas (${nTasks}) <i class="bi bi-arrow-right ms-1"></i></button>
      ${hasV7 ? `<button class="btn btn-outline-secondary btn-sm" data-open-material="${esc(c.id)}"><i class="bi bi-book me-1"></i>Material (${readings.filter((m) => m.curso_id === c.id).length})</button>` : ''}
      ${teacher ? `<button class="btn btn-outline-secondary btn-sm" data-course-students="${esc(c.id)}"><i class="bi bi-people me-1"></i>Alumnas (${nStudents})</button><button class="btn btn-outline-secondary btn-sm" data-edit-course="${esc(c.id)}" title="Editar curso"><i class="bi bi-pencil"></i></button>` : ''}
    </div>
  </div></div></div>`;
}
const courseCards = () => `<div class="row g-3">${courses.map(courseCard).join('')}</div>`;

function taskRow(t) {
  let action;
  if (isTeacher()) {
    const count = submissions.filter((s) => s.tarea_id === t.id).length;
    action = badge(`${count}/${studentsOf(t.curso_id).length} entregas`, 'pill-blue');
  } else {
    action = canSubmit(t) ? `<button class="btn btn-sm btn-primary" data-submit-task="${esc(t.id)}">${mySubmission(t.id) ? 'Actualizar' : 'Entregar'}</button>` : '';
  }
  const nMat = materialsFor(t.id).length;
  return `<div class="task-row clickable" data-open-task="${esc(t.id)}">
    <div class="task-symbol"><i class="bi bi-clipboard-check"></i></div>
    <div class="flex-grow-1 min-w-0">
      <h6 class="fw-bold mb-1">${esc(t.titulo)}</h6>
      <p class="small text-muted mb-1 text-truncate">${esc(courseName(t.curso_id))} · ${esc(t.descripcion)}</p>
      <div class="small muted">Límite: ${esc(fmt(t.fecha_limite))} · ${esc(t.puntos_maximos)} puntos${nMat ? ` · <i class="bi bi-paperclip"></i>${nMat}` : ''}</div>
      <div class="mt-2 d-flex flex-wrap gap-1">${tipoBadge(t)}${isGroupTask(t) ? badge('En grupo', 'pill-orange') : ''}${isTeacher() ? '' : statusFor(t)}</div>
    </div>
    <div class="actions d-flex flex-column flex-sm-row align-items-end gap-2">${action}<button class="btn btn-sm btn-light" data-open-task="${esc(t.id)}">Ver</button></div>
  </div>`;
}

function renderHome() {
  setTitle('Panel principal');
  const teacher = isTeacher();
  const pending = submissions.filter((s) => hasWork(s) && !gradeFor(s.id)).length;
  const myPending = tasks.filter((t) => !mySubmission(t.id) && canSubmit(t)).length;
  const openQ = openQueriesCount();
  const hero = `<div class="hero-banner mb-4">
      <div class="hero-text"><span class="hero-tag"><i class="bi bi-cpu me-1"></i>${esc(today)}</span>
        <h2>${greeting()}, ${esc(me.nombre)}</h2>
        <p>${teacher ? 'Organiza tus cursos, comparte material y acompaña el progreso de tus alumnas.' : 'Revisa tu agenda, lee el material de tus cursos y pregunta cuando lo necesites.'}</p>
        <div class="d-flex flex-wrap gap-2 mt-3">
          <button class="btn btn-light btn-sm" data-go="agenda"><i class="bi bi-calendar3 me-1"></i>Ver agenda</button>
          <button class="btn btn-glass btn-sm" data-go="buscar"><i class="bi bi-search me-1"></i>Buscar información</button>
          ${hasV7 ? `<button class="btn btn-glass btn-sm" data-go="material"><i class="bi bi-book me-1"></i>Material de lectura</button>` : ''}
          ${hasV7 ? `<button class="btn btn-glass btn-sm" data-go="consultas"><i class="bi bi-chat-dots me-1"></i>${teacher ? `Consultas${openQ ? ` (${openQ})` : ''}` : 'Hacer una consulta'}</button>` : ''}
        </div></div>
      <div class="hero-art" aria-hidden="true"><div class="orb"></div><div class="hero-screen"><span></span><span></span><span></span><i class="bi bi-mortarboard-fill"></i></div><i class="bi bi-wifi f1"></i><i class="bi bi-lightbulb f2"></i><i class="bi bi-code-slash f3"></i></div>
    </div>`;
  const stats = teacher
    ? [stat('Mis cursos', courses.length, 'collection', 'pill-purple'), stat('Tareas publicadas', tasks.length, 'journal-text', 'pill-blue'), stat('Por calificar', pending, 'hourglass-split', 'pill-orange'), stat('Consultas abiertas', hasV7 ? openQ : '—', 'chat-dots', 'pill-green')]
    : [stat('Cursos inscritos', courses.length, 'collection', 'pill-purple'), stat('Por entregar', myPending, 'hourglass-split', 'pill-orange'), stat('Entregadas', submissions.filter((s) => s.alumna_id === me.id && hasWork(s)).length, 'check2-circle', 'pill-green'), stat('Material de lectura', hasV7 ? readings.length : '—', 'book', 'pill-blue')];
  const upcoming = tasks.filter((t) => !isExpired(t)).slice(0, 5);
  const courseBtn = teacher
    ? '<button class="btn btn-outline-primary btn-sm" data-action="new-course"><i class="bi bi-plus-lg me-1"></i>Nuevo curso</button>'
    : '<button class="btn btn-outline-primary btn-sm" data-action="join"><i class="bi bi-box-arrow-in-right me-1"></i>Unirme a una clase</button>';
  const tiles = courses.length
    ? `<div class="row g-3 mb-4">${courses.map((c, i) => {
        const cover = c.portada && photoUrls.get(c.portada);
        return `<div class="col-sm-6 col-xxl-4"><button class="cat-tile cat-${i % 4}" data-open-course="${esc(c.id)}" ${cover ? `style="background-image:linear-gradient(135deg,#0b3b3ad9,#0f766ec0),url('${esc(cover)}')"` : ''}>
          <span class="cat-name">${esc(c.nombre)}</span><span class="cat-meta">${esc(c.grado)} · ${esc(c.seccion)}</span>
          <span class="cat-foot"><span><i class="bi bi-clipboard-check"></i> ${tasks.filter((t) => t.curso_id === c.id).length}</span>${hasV7 ? `<span><i class="bi bi-book"></i> ${readings.filter((m) => m.curso_id === c.id).length}</span>` : ''}<i class="bi bi-arrow-up-right ms-auto"></i></span></button></div>`;
      }).join('')}</div>`
    : empty(teacher ? 'Crea tu primer curso para empezar.' : 'Únete a una clase con el código que te dé tu docente.');
  const recentReadings = hasV7 ? [...readings].sort((x, y) => new Date(y.creado_en) - new Date(x.creado_en)).slice(0, 3) : [];
  const side = `<div class="welcome-card mb-3">${avatarHtml(me, 'avatar avatar-lg')}<div class="small opacity-75 mt-2">Bienvenid${teacher ? 'o/a' : 'a'}</div><div class="fw-bold fs-5 lh-sm">${esc(fullName(me))}</div><div class="small opacity-75">${teacher ? 'Docente' : 'Alumna'}${me.clave ? ` · Clave ${esc(me.clave)}` : ''}</div></div>
    <div class="side-card mb-3"><div class="side-title"><i class="bi bi-search"></i>Buscar curso</div><select class="form-select form-select-sm" id="homeCourseSearch"><option value="">Lista de cursos</option>${courses.map((c) => `<option value="${esc(c.id)}">${esc(c.nombre)} · ${esc(c.seccion)}</option>`).join('')}</select></div>
    <div class="side-card mb-3"><div class="side-title"><i class="bi bi-calendar3"></i>Calendario</div>${miniCalendarHtml()}</div>
    ${recentReadings.length ? `<div class="side-card"><div class="side-title"><i class="bi bi-book"></i>Material reciente</div>${recentReadings.map((m) => `<button class="mini-item" data-open-material="${esc(m.curso_id)}"><i class="bi bi-file-earmark-text"></i><span class="text-truncate">${esc(m.titulo)}<small>${esc(courseName(m.curso_id))}</small></span></button>`).join('')}</div>` : ''}`;
  $('#mainContent').innerHTML = `<div class="row g-4"><div class="col-xl-9">${hero}<div class="row g-3 mb-4">${stats.join('')}</div>
    <div class="section-bar"><h4 class="section-heading mb-0">Mis cursos</h4>${courseBtn}</div>${tiles}
    <div class="section-bar"><h4 class="section-heading mb-0">Próximas actividades</h4>${teacher ? '<button class="btn btn-primary btn-sm" data-action="new-task"><i class="bi bi-plus-lg me-1"></i>Nueva tarea</button>' : ''}</div>
    <div class="surface-card mb-4">${upcoming.length ? upcoming.map(taskRow).join('') : empty('No hay actividades próximas.')}</div></div>
    <div class="col-xl-3"><div class="home-side">${side}</div></div></div>`;
}

function renderCourses() {
  setTitle('Mis cursos');
  const teacher = isTeacher();
  $('#mainContent').innerHTML = `<div class="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-4">
      <div><h4 class="section-heading mb-1">Tus espacios de aprendizaje</h4><p class="muted mb-0">${teacher ? 'Comparte el código de clase con tus alumnas para que se unan.' : 'Consulta los cursos asociados a tu cuenta.'}</p></div>
      ${teacher ? '<button class="btn btn-primary" data-action="new-course"><i class="bi bi-plus-lg me-1"></i>Nuevo curso</button>' : '<button class="btn btn-primary" data-action="join"><i class="bi bi-box-arrow-in-right me-1"></i>Unirme a una clase</button>'}
    </div>${courses.length ? courseCards() : empty(teacher ? 'Todavía no has creado cursos.' : 'Aún no estás en ninguna clase.')}`;
}

function renderTasks(courseId = null) {
  setTitle('Tareas');
  const list = courseId ? tasks.filter((t) => t.curso_id === courseId) : tasks;
  const options = `<option value="">Todos los cursos</option>${courses.map((c) => `<option value="${esc(c.id)}" ${c.id === courseId ? 'selected' : ''}>${esc(c.nombre)} · ${esc(c.seccion)}</option>`).join('')}`;
  $('#mainContent').innerHTML = `<div class="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-4">
      <div><h4 class="section-heading mb-1">${courseId ? esc(courseName(courseId)) : 'Actividades y tareas'}</h4><p class="muted mb-0">${list.length} actividades</p></div>
      <div class="d-flex gap-2"><select class="form-select form-select-sm" id="taskCourseFilter" style="min-width:200px">${options}</select>${isTeacher() ? '<button class="btn btn-primary text-nowrap" data-action="new-task"><i class="bi bi-plus-lg me-1"></i>Nueva tarea</button>' : ''}</div>
    </div><div class="surface-card">${list.length ? list.map(taskRow).join('') : empty('Aún no hay tareas para mostrar.')}</div>`;
}

async function renderTaskDetail(id) {
  const t = task(id);
  if (!t) { navigate('tareas'); return; }
  const token = renderToken;
  const teacher = isTeacher();
  setTitle(t.titulo, 'Tareas');
  loading();

  const matHtml = await fileListHtml(materialsFor(id), teacher ? 'data-delete-material' : null, 'Sin material adjunto');
  let side;
  if (teacher) {
    side = await teacherTaskPanel(t);
  } else {
    const s = mySubmission(id);
    const g = s && gradeFor(s.id);
    const myFiles = s ? await fileListHtml(filesFor(s.id)) : '';
    const updated = s?.actualizado_en && new Date(s.actualizado_en) - new Date(s.fecha_entrega) > 60000 ? ` · actualizada ${esc(fmt(s.actualizado_en))}` : '';
    const work = s
      ? `${s.contenido ? `<div class="mb-2">${pre(s.contenido)}</div>` : ''}${safeHttpUrl(s.enlace) ? `<p class="mb-2"><a target="_blank" rel="noopener noreferrer" href="${esc(safeHttpUrl(s.enlace))}">Tu enlace <i class="bi bi-box-arrow-up-right"></i></a></p>` : ''}${myFiles}
         <div class="small muted mt-2">Entregada el ${esc(fmt(s.fecha_entrega))}${updated}${isLate(s) ? ' · <span class="text-danger">entrega tardía</span>' : ''}</div>`
      : `<p class="muted mb-0">${isGroupTask(t) && /grupo/.test(statusFor(t)) ? 'Tu grupo ya entregó. Puedes subir otra versión si hace falta.' : 'Aún no has entregado esta actividad.'}</p>`;
    const action = canSubmit(t)
      ? `<button class="btn btn-primary w-100 mt-3" data-submit-task="${esc(t.id)}">${s ? 'Actualizar entrega' : 'Entregar'}</button>`
      : g ? '' : '<p class="small text-danger mt-3 mb-0">La fecha límite ya pasó.</p>';
    let groupBox = '';
    if (isGroupTask(t)) {
      const grp = groupOf(me.id, t.curso_id);
      const cc = course(t.curso_id);
      if (!grp) groupBox = hasV6(cc) && cc.grupos_abiertos
        ? `<div class="alert alert-warning small d-flex justify-content-between align-items-center gap-2">Esta actividad es en grupo y aún no tienes grupo.<button class="btn btn-sm btn-warning text-nowrap" data-choose-group="${esc(cc.id)}">Elegir grupo</button></div>`
        : '<div class="alert alert-warning small">Esta actividad es en grupo, pero aún no estás en un grupo. Tu docente te asignará uno.</div>';
      else {
        const team = membersOf(grp.id);
        const teamSubs = team.filter((m) => m.alumna_id !== me.id).map((m) => submissionOf(t.id, m.alumna_id)).filter(hasWork);
        const teamFiles = teamSubs.length ? await fileListHtml(teamSubs.flatMap((x) => filesFor(x.id))) : '';
        groupBox = `<div class="surface-card mb-3"><h6 class="fw-bold mb-1"><i class="bi bi-people me-1"></i>${esc(grp.nombre)}</h6>
          <div class="small muted mb-2">${team.map((m) => esc(fullName(m.usuarios))).join(' · ')}</div>
          ${teamSubs.length ? `<div class="small fw-semibold mb-1">Lo que ya entregó tu grupo:</div>${teamFiles}` : '<div class="small muted">Nadie de tu grupo ha entregado todavía. Basta con que una integrante entregue.</div>'}</div>`;
      }
    }
    const expoHint = isExpo(t) ? '<div class="alert alert-info small"><i class="bi bi-easel me-1"></i>Sube tu presentación. Tu docente te calificará mientras expones.</div>' : '';
    const askBtn = hasV7 ? `<div class="surface-card mb-3 ask-card"><div class="d-flex align-items-center gap-3"><div class="task-symbol"><i class="bi bi-chat-dots"></i></div><div class="flex-grow-1"><div class="fw-bold">¿Tienes dudas?</div><div class="small muted">Escríbele a tu docente sobre esta actividad.</div></div><button class="btn btn-sm btn-outline-primary text-nowrap" data-ask-task="${esc(t.id)}">Consultar</button></div></div>` : '';
    side = `${groupBox}${askBtn}<div class="surface-card mb-3"><div class="d-flex justify-content-between align-items-center mb-3"><h6 class="fw-bold mb-0">Tu trabajo</h6>${statusFor(t)}</div>${expoHint}${hasWork(s) || !s ? work : '<p class="muted mb-0">No subiste archivos para esta actividad.</p>'}${action}</div>
      ${g ? `<div class="surface-card grade-card"><h6 class="fw-bold mb-2">Calificación</h6><div class="grade-value">${esc(g.nota)} <span>/ ${esc(t.puntos_maximos)}</span></div><div class="small muted">Calificada el ${esc(fmt(g.calificado_en))}</div><h6 class="fw-bold mt-3 mb-1">Comentario de tu docente</h6>${pre(g.comentario || 'Sin comentarios.')}</div>` : ''}`;
  }
  if (token !== renderToken) return; // el usuario ya cambió de pantalla

  $('#mainContent').innerHTML = `<button class="btn btn-link ps-0 mb-3" data-back="tareas"><i class="bi bi-arrow-left"></i> Volver a tareas</button>
    <div class="row g-4">
      <div class="${teacher ? 'col-12' : 'col-lg-7'}"><div class="surface-card">
        <div class="d-flex flex-wrap gap-2 mb-2">${tipoBadge(t)}${isGroupTask(t) ? badge('En grupo', 'pill-orange') : ''}${t.permite_entrega_tardia ? badge('Acepta entregas tardías', 'pill-green') : ''}</div>
        <h3 class="fw-bold mb-1">${esc(t.titulo)}</h3>
        <div class="small muted mb-3">${esc(courseName(t.curso_id))} · Publicada el ${esc(fmt(t.fecha_publicacion))}</div>
        <div class="d-flex flex-wrap gap-3 small mb-4"><span><i class="bi bi-calendar-event me-1"></i>Límite: <strong>${esc(fmt(t.fecha_limite))}</strong></span><span><i class="bi bi-star me-1"></i>${esc(t.puntos_maximos)} puntos</span></div>
        ${pre(t.descripcion)}
        ${t.instrucciones ? `<h6 class="fw-bold mt-4 mb-2">Instrucciones</h6>${pre(t.instrucciones)}` : ''}
        <h6 class="fw-bold mt-4 mb-2">Material de apoyo</h6>${matHtml}
        ${teacher ? `<div class="d-flex gap-2 mt-4"><button class="btn btn-outline-primary btn-sm" data-edit-task="${esc(t.id)}"><i class="bi bi-pencil me-1"></i>Editar</button><button class="btn btn-outline-danger btn-sm" data-delete-task="${esc(t.id)}"><i class="bi bi-trash me-1"></i>Eliminar</button></div>` : ''}
      </div></div>
      <div class="${teacher ? 'col-12' : 'col-lg-5'}">${side}</div>
    </div>`;
}

// Tabla de la docente: ver trabajos y calificar rápido (por alumna o por grupo)
async function signedMap(list) {
  const map = new Map();
  if (!list.length) return map;
  const { data } = await db.storage.from(BUCKET).createSignedUrls(list.map((f) => f.ruta_storage), 900);
  for (const d of data || []) if (d.signedUrl) map.set(d.path, d.signedUrl);
  return map;
}
async function teacherTaskPanel(t) {
  let students = studentsOf(t.curso_id);
  const taskSubs = submissions.filter((x) => x.tarea_id === t.id);
  const urls = await signedMap(taskSubs.flatMap((x) => filesFor(x.id)));
  await loadPhotos(students.map((en) => en.usuarios));
  const max = esc(t.puntos_maximos);

  const workLinks = (subs) => {
    const out = [];
    for (const x of subs) {
      for (const f of filesFor(x.id)) {
        const u = urls.get(f.ruta_storage);
        out.push(u ? `<a class="file-mini" target="_blank" rel="noopener noreferrer" href="${esc(u)}"><i class="bi bi-paperclip"></i> ${esc(f.nombre_archivo)}</a>` : `<span class="file-mini">${esc(f.nombre_archivo)}</span>`);
      }
      if (safeHttpUrl(x.enlace)) out.push(`<a class="file-mini" target="_blank" rel="noopener noreferrer" href="${esc(safeHttpUrl(x.enlace))}"><i class="bi bi-link-45deg"></i> Enlace</a>`);
      if (x.contenido) out.push(`<button class="btn btn-link btn-sm p-0" data-view-submission="${esc(x.id)}">Ver respuesta</button>`);
    }
    return out.length ? `<div class="d-flex flex-column gap-1">${out.join('')}</div>` : '<span class="small muted">—</span>';
  };
  const status = (worked, late) => worked
    ? badge('Entregó', 'pill-purple') + (late ? ' ' + badge('Tardía', 'pill-orange') : '')
    : (isExpired(t) && !isExpo(t) ? badge('No entregó', 'pill-orange') : badge('Pendiente', 'pill-blue'));
  const gradeCell = (g, attr) => hasV5
    ? `<div class="quick-grade"><input type="number" class="form-control form-control-sm" data-q-nota min="0" max="${max}" step="0.01" value="${g ? esc(g.nota) : ''}" placeholder="/ ${max}"><input class="form-control form-control-sm" data-q-com maxlength="500" value="${esc(g?.comentario || '')}" placeholder="Comentario (opcional)"><button class="btn btn-sm ${g ? 'btn-success' : 'btn-primary'}" ${attr} title="Guardar nota"><i class="bi bi-check-lg"></i></button></div>`
    : '';

  const rows = [];
  let gradedCount = 0;
  if (isGroupTask(t)) {
    for (const grp of groupsOf(t.curso_id)) {
      const ms = membersOf(grp.id);
      if (!ms.length) continue;
      const subs = ms.map((m) => submissionOf(t.id, m.alumna_id)).filter(Boolean);
      const grs = subs.map((x) => gradeFor(x.id)).filter(Boolean);
      const mixed = grs.length && (grs.length !== ms.length || grs.some((x) => Number(x.nota) !== Number(grs[0].nota)));
      if (grs.length === ms.length) gradedCount++;
      const worked = subs.filter(hasWork);
      rows.push(`<tr><td><div class="fw-bold">${esc(grp.nombre)}</div><div class="small muted">${ms.map((m) => `${esc(m.usuarios?.clave ?? '')} ${esc(listName(m.usuarios))}`).join('<br>')}</div></td>
        <td>${workLinks(worked)}</td><td>${status(worked.length > 0, worked.some(isLate))}${mixed ? '<div class="small text-warning mt-1">Notas distintas entre integrantes</div>' : ''}</td>
        <td>${gradeCell(mixed ? null : grs[0], `data-quick-group="${esc(grp.id)}"`)}</td></tr>`);
    }
    students = students.filter((en) => !groupOf(en.alumna_id, t.curso_id));
    if (students.length) rows.push(`<tr class="sep-row"><td colspan="4">Alumnas sin grupo (se califican una por una)</td></tr>`);
  }
  for (const en of students) {
    const x = submissionOf(t.id, en.alumna_id);
    const g = x && gradeFor(x.id);
    if (g) gradedCount++;
    rows.push(`<tr><td><div class="d-flex align-items-center gap-2">${avatarHtml(en.usuarios)}<div><span class="muted me-1">${esc(en.usuarios?.clave ?? '')}</span><span class="fw-semibold">${esc(listName(en.usuarios))}</span></div></div></td>
      <td>${hasWork(x) ? workLinks([x]) : '<span class="small muted">—</span>'}</td><td>${status(hasWork(x), x && isLate(x))}</td>
      <td>${hasV5 ? gradeCell(g, `data-quick-alumna="${esc(en.alumna_id)}"`) : (x ? `<button class="btn btn-sm btn-outline-primary" data-view-submission="${esc(x.id)}">${g ? `${esc(g.nota)}/${max} · Abrir` : 'Abrir'}</button>` : '')}</td></tr>`);
  }
  const total = isGroupTask(t) ? groupsOf(t.curso_id).filter((g) => membersOf(g.id).length).length + students.length : students.length;
  const title = isExpo(t) ? '<i class="bi bi-easel me-1"></i>Calificar exposiciones' : 'Trabajos y calificaciones';
  const hint = isExpo(t)
    ? 'Escribe la nota mientras exponen y presiona Enter o ✓. No hace falta que hayan subido la presentación.'
    : 'Escribe la nota y presiona Enter o ✓. Deja la nota vacía y guarda para quitarla.';
  return `<div class="surface-card"><div class="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-1"><h6 class="fw-bold mb-0">${title}</h6><span class="small muted">${gradedCount} de ${total} calificadas</span></div>
    ${hasV5 ? `<p class="small muted mb-3">${hint}</p>` : '<p class="small text-warning mb-3">Para calificar desde aquí ejecuta migracion-v5 en Supabase.</p>'}
    ${rows.length ? `<div class="table-responsive"><table class="table align-middle mb-0 grade-table"><thead><tr><th>${isGroupTask(t) ? 'Grupo / alumna' : 'Alumna'}</th><th>Trabajo</th><th>Estado</th><th style="min-width:300px">Nota (de ${max}) y comentario</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>` : empty('Este curso todavía no tiene alumnas inscritas.')}</div>`;
}

async function quickGrade(btn) {
  const row = btn.closest('tr');
  const t = task(viewArg);
  if (!t || !row) return;
  const raw = row.querySelector('[data-q-nota]').value.trim();
  const nota = raw === '' ? null : Number(raw);
  if (nota !== null && (!Number.isFinite(nota) || nota < 0 || nota > Number(t.puntos_maximos))) {
    return notify(`La nota debe estar entre 0 y ${t.puntos_maximos}.`, 'warning');
  }
  const comentario = row.querySelector('[data-q-com]').value.trim() || null;
  await busy(btn, async () => {
    const r = btn.dataset.quickGroup
      ? await db.rpc('calificar_grupo', { p_tarea: t.id, p_grupo: btn.dataset.quickGroup, p_nota: nota, p_comentario: comentario })
      : await db.rpc('calificar', { p_tarea: t.id, p_alumna: btn.dataset.quickAlumna, p_nota: nota, p_comentario: comentario });
    if (r.error) return notify(errMsg(r.error), 'danger');
    notify(nota === null ? 'Nota quitada.' : btn.dataset.quickGroup ? `Nota guardada para ${r.data} integrantes.` : 'Nota guardada.', 'success', 1800);
    const idx = [...document.querySelectorAll('[data-q-nota]')].indexOf(row.querySelector('[data-q-nota]'));
    const y = window.scrollY;
    await refresh(true);
    window.scrollTo(0, y);
    document.querySelectorAll('[data-q-nota]')[idx + 1]?.focus(); // pasar a la siguiente
  });
}

function renderSubmissions() {
  setTitle('Entregas', 'Mi espacio');
  if (!isTeacher()) { navigate('inicio'); return; }
  const tabs = `<div class="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-4"><div class="btn-group" role="group">
    <button class="btn btn-sm ${entregasTab === 'resumen' ? 'btn-primary' : 'btn-outline-primary'}" data-entregas-tab="resumen"><i class="bi bi-bar-chart me-1"></i>Resumen</button>
    <button class="btn btn-sm ${entregasTab === 'lista' ? 'btn-primary' : 'btn-outline-primary'}" data-entregas-tab="lista"><i class="bi bi-inboxes me-1"></i>Lista de entregas</button></div>
    <button class="btn btn-sm btn-outline-primary" data-open-download><i class="bi bi-file-earmark-zip me-1"></i>Descargar tareas (ZIP)</button></div>`;
  if (entregasTab === 'resumen') { $('#mainContent').innerHTML = tabs + dashboardHtml(); return; }
  const list = submissions.filter(hasWork).filter((s) => !dashCourse || task(s.tarea_id)?.curso_id === dashCourse);
  const rows = list.map((s) => {
    const g = gradeFor(s.id);
    return `<tr><td class="fw-semibold">${esc(studentName(s.alumna_id))}</td><td>${esc(task(s.tarea_id)?.titulo || 'Tarea')}<div class="small muted">${esc(courseName(task(s.tarea_id)?.curso_id))}</div></td><td class="small">${esc(fmt(s.fecha_entrega))}</td><td>${g ? badge('Calificada', 'pill-green') : badge('Por revisar', 'pill-orange')} ${isLate(s) ? badge('Tardía', 'pill-orange') : ''}</td><td><button class="btn btn-sm btn-outline-primary" data-view-submission="${esc(s.id)}">Abrir</button></td></tr>`;
  });
  $('#mainContent').innerHTML = tabs + `<div class="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-3"><div><h4 class="section-heading mb-1">Trabajos de tus alumnas</h4><p class="muted mb-0">Revisa, abre los archivos y registra una calificación.</p></div>${dashCourseSelect()}</div>
    <div class="surface-card table-responsive">${rows.length ? `<table class="table table-hover align-middle mb-0"><thead><tr><th>Alumna</th><th>Actividad</th><th>Fecha</th><th>Estado</th><th>Revisar</th></tr></thead><tbody>${rows.join('')}</tbody></table>` : empty('Las alumnas todavía no han enviado trabajos.')}</div>`;
}

// ===================== RESUMEN (dashboard de la docente) =====================
const BINS = [
  { key: 'b0', label: '0–59', min: 0, max: 60 },
  { key: 'b60', label: '60–69', min: 60, max: 70 },
  { key: 'b70', label: '70–79', min: 70, max: 80 },
  { key: 'b80', label: '80–89', min: 80, max: 90 },
  { key: 'b90', label: '90–100', min: 90, max: 1000 },
  { key: 'none', label: 'Sin nota aún' },
];
const binOf = (pct) => (pct === null ? BINS[5] : BINS.find((b) => b.min !== undefined && pct >= b.min && pct < b.max));
function dashCourseSelect() {
  return `<select class="form-select form-select-sm" id="dashCourse" style="width:auto;min-width:240px" aria-label="Filtrar por curso">
    <option value="">Todos los cursos</option>${courses.map((c) => `<option value="${esc(c.id)}" ${c.id === dashCourse ? 'selected' : ''}>${esc(c.nombre)} · ${esc(c.grado)} ${esc(c.seccion)}</option>`).join('')}</select>`;
}
function dashData() {
  if (dashCourse && !course(dashCourse)) dashCourse = '';
  const cs = dashCourse ? [course(dashCourse)] : courses;
  const ids = new Set(cs.map((c) => c.id));
  const ts = tasks.filter((t) => ids.has(t.curso_id) && t.publicada);
  // Una fila por alumna (si está en varios cursos se suman sus puntos)
  const people = new Map();
  for (const en of enrollments.filter((e) => ids.has(e.curso_id))) {
    const a = accumulated(en.alumna_id, en.curso_id);
    const p = people.get(en.alumna_id) || { id: en.alumna_id, u: en.usuarios, earned: 0, possible: 0, missing: 0, cursos: [] };
    p.earned += a.earned; p.possible += a.possible; p.cursos.push(en.curso_id);
    p.missing += ts.filter((t) => t.curso_id === en.curso_id && isExpired(t) && !isExpo(t)).filter((t) => { const x = submissionOf(t.id, en.alumna_id); return !hasWork(x) && !gradeFor(x?.id); }).length;
    people.set(en.alumna_id, p);
  }
  const list = [...people.values()].map((p) => ({ ...p, pct: p.possible ? (p.earned / p.possible) * 100 : null }));
  // Estado de cada tarea
  const taskRows = ts.map((t) => {
    const st = studentsOf(t.curso_id);
    const c = { graded: 0, toGrade: 0, missing: 0, pending: 0, total: st.length };
    for (const en of st) {
      const x = submissionOf(t.id, en.alumna_id);
      if (gradeFor(x?.id)) c.graded++;
      else if (hasWork(x)) c.toGrade++;
      else if (isExpired(t) && !isExpo(t)) c.missing++;
      else c.pending++;
    }
    return { t, ...c };
  }).sort((a, b) => new Date(b.t.fecha_limite) - new Date(a.t.fecha_limite));
  const courseAvg = cs.map((c) => {
    const ps = list.filter((p) => p.cursos.includes(c.id)).map((p) => accumulated(p.id, c.id).pct).filter((x) => x !== null);
    return { c, avg: ps.length ? ps.reduce((x, y) => x + y, 0) / ps.length : null, n: studentsOf(c.id).length };
  });
  return { cs, ts, list, taskRows, courseAvg };
}
function dashboardHtml() {
  if (!courses.length) return empty('Primero crea un curso.');
  const { ts, list, taskRows, courseAvg } = dashData();
  const withPct = list.filter((p) => p.pct !== null);
  const avg = withPct.length ? withPct.reduce((x, p) => x + p.pct, 0) / withPct.length : null;
  const assigned = taskRows.reduce((x, r) => x + r.total, 0);
  const delivered = taskRows.reduce((x, r) => x + r.graded + r.toGrade, 0);
  const toGrade = taskRows.reduce((x, r) => x + r.toGrade, 0);
  const atRisk = withPct.filter((p) => p.pct < 60).length;
  const tile = (label, value, sub, icon, pill) => `<div class="col-6 col-xl"><div class="stat-card h-100"><div class="stat-icon ${pill}"><i class="bi bi-${icon}"></i></div><h3>${value}</h3><div class="stat-label">${label}</div>${sub ? `<div class="small muted mt-1">${sub}</div>` : ''}</div></div>`;
  const tiles = `<div class="row g-3 mb-4">
    ${tile('Alumnas', list.length, `${ts.length} actividades`, 'people', 'pill-purple')}
    ${tile('Promedio general', avg === null ? '—' : `${Math.round(avg)}%`, 'nota acumulada', 'graph-up', 'pill-blue')}
    ${tile('Trabajos entregados', assigned ? `${Math.round((delivered / assigned) * 100)}%` : '—', `${delivered} de ${assigned}`, 'check2-circle', 'pill-green')}
    ${tile('Por calificar', toGrade, 'entregas sin nota', 'hourglass-split', 'pill-orange')}
    ${tile('Necesitan apoyo', atRisk, 'menos de 60%', 'exclamation-triangle', 'pill-orange')}</div>`;

  // Histograma de notas acumuladas
  const counts = BINS.map((b) => ({ b, people: list.filter((p) => binOf(p.pct) === b) }));
  const maxCount = Math.max(1, ...counts.map((x) => x.people.length));
  const hist = `<div class="viz-hist" role="img" aria-label="Cuántas alumnas hay en cada rango de nota acumulada">${counts.map(({ b, people }) => {
    const h = people.length ? Math.max(4, (people.length / maxCount) * 100) : 0;
    const tip = `${b.label}${b.key === 'none' ? '' : '%'}: ${people.length} alumna${people.length === 1 ? '' : 's'}${people.length ? ' · clic para ver la lista' : ''}`;
    return `<button type="button" class="viz-col ${dashBin === b.key ? 'active' : ''}" data-dash-bin="${b.key}" data-tip="${esc(tip)}" ${people.length ? '' : 'disabled'}>
      <span class="viz-val">${people.length}</span>
      <span class="viz-bar-wrap"><span class="viz-bar ${b.key === 'none' ? 'is-none' : ''}" style="height:${h}%"></span></span>
      <span class="viz-lab">${esc(b.label)}</span></button>`;
  }).join('')}</div>`;

  // Barras apiladas por actividad
  const seg = (n, total, cls, label, r) => (n ? `<span class="viz-seg ${cls}" style="flex:${n}" data-tip="${esc(`${r.t.titulo} · ${label}: ${n} de ${total}`)}"></span>` : '');
  const legend = `<div class="viz-legend"><span><i class="sw s-graded"></i>Calificada</span><span><i class="sw s-tograde"></i>Entregada, por calificar</span><span><i class="sw s-missing"></i>No entregó (vencida)</span><span><i class="sw s-pending"></i>Pendiente</span></div>`;
  const stack = taskRows.length ? taskRows.slice(0, 15).map((r) => `<div class="viz-row clickable" data-open-task="${esc(r.t.id)}">
      <div class="viz-row-lab"><div class="text-truncate fw-semibold small">${esc(r.t.titulo)}</div><div class="text-truncate muted" style="font-size:.75rem">${esc(courseName(r.t.curso_id))} · ${esc(fmt(r.t.fecha_limite))}</div></div>
      <div class="viz-stack">${r.total ? seg(r.graded, r.total, 's-graded', 'Calificadas', r) + seg(r.toGrade, r.total, 's-tograde', 'Por calificar', r) + seg(r.missing, r.total, 's-missing', 'No entregaron', r) + seg(r.pending, r.total, 's-pending', 'Pendientes', r) : '<span class="viz-seg s-pending" style="flex:1"></span>'}</div>
      <div class="viz-row-val small">${r.graded + r.toGrade}/${r.total}<span class="muted"> entregas</span>${r.missing ? `<div class="text-danger" style="font-size:.75rem">${r.missing} sin entregar</div>` : ''}</div></div>`).join('')
    + (taskRows.length > 15 ? `<p class="small muted mt-2 mb-0">Se muestran las 15 actividades más recientes de ${taskRows.length}.</p>` : '')
    : empty('Todavía no hay actividades en este curso.');

  // Promedio por curso (solo con "Todos los cursos")
  const perCourse = !dashCourse && courseAvg.length > 1 ? `<div class="surface-card mb-4"><h6 class="fw-bold mb-1">Promedio por curso</h6><p class="small muted mb-3">Nota acumulada promedio de las alumnas de cada curso.</p>
    ${courseAvg.map(({ c, avg: a, n }) => `<div class="viz-hrow" data-tip="${esc(`${c.nombre} ${c.seccion}: ${a === null ? 'sin notas aún' : `${Math.round(a)}%`} · ${n} alumnas`)}">
      <div class="viz-row-lab small"><span class="fw-semibold">${esc(c.nombre)}</span> <span class="muted">${esc(c.grado)} ${esc(c.seccion)}</span></div>
      <div class="viz-htrack"><span class="viz-hbar" style="width:${a === null ? 0 : Math.min(100, a)}%"></span></div>
      <div class="viz-row-val small fw-bold">${a === null ? '—' : `${Math.round(a)}%`}</div></div>`).join('')}</div>` : '';

  // Tabla: rango elegido o alumnas que necesitan apoyo
  const chosen = dashBin ? BINS.find((b) => b.key === dashBin) : null;
  const tableList = (chosen ? list.filter((p) => binOf(p.pct) === chosen) : list.filter((p) => (p.pct !== null && p.pct < 60) || p.missing >= 2))
    .sort((x, y) => (x.pct ?? 999) - (y.pct ?? 999) || y.missing - x.missing);
  const tTitle = chosen ? `Alumnas con nota ${chosen.label}${chosen.key === 'none' ? '' : '%'}` : 'Alumnas que necesitan apoyo';
  const tHint = chosen ? '<button class="btn btn-link btn-sm p-0" data-dash-bin="">Ver las que necesitan apoyo</button>' : '<span class="small muted">Nota acumulada menor a 60% o 2 o más tareas vencidas sin entregar. Haz clic en una barra de la gráfica para ver otro rango.</span>';
  const table = `<div class="surface-card"><div class="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-3"><h6 class="fw-bold mb-0">${tTitle} (${tableList.length})</h6>${tHint}</div>
    ${tableList.length ? `<div class="table-responsive"><table class="table table-hover align-middle mb-0"><thead><tr><th class="text-center">Clave</th><th>Alumna</th><th>Curso</th><th>Sin entregar</th><th>Nota acumulada</th></tr></thead><tbody>${tableList.map((p) => `<tr>
      <td class="text-center clave-cell">${esc(p.u?.clave ?? '—')}</td><td class="fw-semibold">${esc(listName(p.u))}</td>
      <td class="small">${p.cursos.map((id) => esc(`${course(id)?.nombre || ''} ${course(id)?.seccion || ''}`)).join('<br>')}</td>
      <td>${p.missing ? `<span class="text-danger fw-bold">${p.missing}</span>` : '0'}</td>
      <td class="text-nowrap">${accHtml({ earned: p.earned, possible: p.possible, pct: p.pct })}</td></tr>`).join('')}</tbody></table></div>`
      : `<p class="muted mb-0">${chosen ? 'No hay alumnas en este rango.' : '¡Muy bien! Ninguna alumna necesita apoyo por ahora.'}</p>`}</div>`;

  return `<div class="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-3">
      <div><h4 class="section-heading mb-1">¿Cómo van tus alumnas?</h4><p class="muted mb-0">${dashCourse ? esc(`${course(dashCourse).nombre} · ${course(dashCourse).grado} ${course(dashCourse).seccion}`) : 'Todos tus cursos'}</p></div>${dashCourseSelect()}</div>
    ${tiles}
    <div class="row g-4 mb-4">
      <div class="col-lg-5"><div class="surface-card h-100"><h6 class="fw-bold mb-1">Distribución de notas</h6><p class="small muted mb-3">Cuántas alumnas hay en cada rango de nota acumulada.</p>${hist}</div></div>
      <div class="col-lg-7"><div class="surface-card h-100"><h6 class="fw-bold mb-1">Entregas por actividad</h6><p class="small muted mb-2">Haz clic en una actividad para calificarla.</p>${legend}<div class="mt-2">${stack}</div></div></div>
    </div>
    ${perCourse}${table}`;
}

async function renderSubmissionDetail(id) {
  const s = submissions.find((x) => x.id === id);
  if (!s || !isTeacher()) { navigate('entregas'); return; }
  const token = renderToken;
  const t = task(s.tarea_id);
  const g = gradeFor(id);
  setTitle('Revisar entrega', 'Entregas');
  loading();
  const fileHtml = await fileListHtml(filesFor(id));
  if (token !== renderToken) return;
  const updated = s.actualizado_en && new Date(s.actualizado_en) - new Date(s.fecha_entrega) > 60000 ? ` · Actualizada el ${esc(fmt(s.actualizado_en))}` : '';
  $('#mainContent').innerHTML = `<button class="btn btn-link ps-0 mb-3" data-back="tarea:${esc(s.tarea_id)}"><i class="bi bi-arrow-left"></i> Volver a la tarea</button>
    <h4 class="section-heading">${esc(t?.titulo || 'Tarea')}</h4>
    <p class="muted">${esc(studentName(s.alumna_id))} · Entregada el ${esc(fmt(s.fecha_entrega))}${updated} ${isLate(s) ? badge('Tardía', 'pill-orange') : ''}</p>
    <div class="surface-card mb-3"><h6 class="fw-bold">Respuesta</h6>${pre(s.contenido || 'Sin comentario escrito')}
      ${safeHttpUrl(s.enlace) ? `<p class="mt-3 mb-0"><a target="_blank" rel="noopener noreferrer" href="${esc(safeHttpUrl(s.enlace))}">Enlace proporcionado <i class="bi bi-box-arrow-up-right"></i></a></p>` : ''}
      <h6 class="fw-bold mt-3">Archivos</h6>${fileHtml}</div>
    <div class="surface-card">${g ? `<h5>Calificación actual: ${esc(g.nota)} / ${esc(t?.puntos_maximos)} puntos</h5><div class="mb-3">${pre(g.comentario || 'Sin observaciones')}</div>` : '<p class="muted">Aún no has calificado esta entrega.</p>'}
      <button class="btn btn-primary" data-grade="${esc(s.id)}">${g ? 'Editar calificación' : 'Calificar entrega'}</button></div>`;
}

async function renderStudents() {
  setTitle('Alumnas');
  if (!isTeacher()) { navigate('inicio'); return; }
  const header = (extra = '') => `<div class="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-4">
      <div><h4 class="section-heading mb-1">Alumnas por curso</h4><p class="muted mb-0">Inscribe alumnas, forma grupos y revisa cómo van.</p></div>
      <div class="d-flex flex-wrap gap-2">${extra}<button class="btn btn-primary" data-action="create-account"><i class="bi bi-person-plus me-1"></i>Crear cuenta</button></div></div>`;
  if (!courses.length) { $('#mainContent').innerHTML = header() + empty('Primero crea un curso.'); return; }
  if (!course(studentsCourse)) studentsCourse = courses[0].id;
  const c = course(studentsCourse);
  const list = studentsOf(c.id);
  const courseTasks = tasks.filter((t) => t.curso_id === c.id);
  const token = renderToken;
  await loadPhotos(list.map((en) => en.usuarios));
  if (token !== renderToken) return;

  const select = `<select class="form-select" id="studentsCourseSelect" style="min-width:220px">${courses.map((x) => `<option value="${esc(x.id)}" ${x.id === c.id ? 'selected' : ''}>${esc(x.nombre)} · ${esc(x.grado)} ${esc(x.seccion)}</option>`).join('')}</select>`;
  const tabs = hasV5 ? `<div class="btn-group" role="group">
      <button class="btn btn-sm ${studentsTab === 'lista' ? 'btn-primary' : 'btn-outline-primary'}" data-students-tab="lista"><i class="bi bi-list-ol me-1"></i>Lista</button>
      <button class="btn btn-sm ${studentsTab === 'grupos' ? 'btn-primary' : 'btn-outline-primary'}" data-students-tab="grupos"><i class="bi bi-people me-1"></i>Grupos (${groupsOf(c.id).length})</button></div>` : '';
  const toolbar = `<div class="surface-card mb-3 d-flex flex-wrap align-items-center gap-3">${select}
      ${c.codigo_clase ? `<div class="class-code"><span class="small muted">Código de clase</span><strong>${esc(c.codigo_clase)}</strong><button class="btn btn-sm btn-link p-0" data-copy-code="${esc(c.codigo_clase)}" title="Copiar"><i class="bi bi-copy"></i></button></div>` : ''}
      <div class="ms-auto d-flex align-items-center gap-3">${tabs}<span class="muted small">${list.length} alumnas</span></div></div>`;

  if (studentsTab === 'grupos' && hasV5) {
    $('#mainContent').innerHTML = header() + toolbar + groupsPanel(c, list, courseTasks);
    return;
  }

  const sorted = [...list];
  const acc = new Map(list.map((en) => [en.alumna_id, accumulated(en.alumna_id, c.id)]));
  if (studentsSort === 'apellido') sorted.sort((a, b) => listName(a.usuarios).localeCompare(listName(b.usuarios), 'es'));
  if (studentsSort === 'nota') sorted.sort((a, b) => (acc.get(b.alumna_id).pct ?? -1) - (acc.get(a.alumna_id).pct ?? -1));
  if (studentsSort === 'grupo') sorted.sort((a, b) => (groupOf(a.alumna_id, c.id)?.nombre || '~').localeCompare(groupOf(b.alumna_id, c.id)?.nombre || '~', 'es', { numeric: true }) || byClave(a.usuarios, b.usuarios));

  const plain = (v) => String(v ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const rows = sorted.map((en) => {
    const u = en.usuarios;
    const done = courseTasks.filter((t) => hasWork(submissionOf(t.id, en.alumna_id)) || gradeFor(submissionOf(t.id, en.alumna_id)?.id)).length;
    const grp = hasV5 ? groupOf(en.alumna_id, c.id) : null;
    return `<tr data-search="${esc(plain(`${u?.clave ?? ''} ${listName(u)} ${u?.usuario} ${grp?.nombre || ''}`))}">
      <td class="fw-bold text-center clave-cell">${esc(u?.clave ?? '—')}</td>
      <td><div class="d-flex align-items-center gap-2">${avatarHtml(u)}<span class="fw-semibold">${esc(listName(u))}</span></div></td>
      <td><code>${esc(u?.usuario)}</code></td>
      ${hasV5 ? `<td>${grp ? badge(grp.nombre, 'pill-blue') : '<span class="small muted">—</span>'}</td>` : ''}
      <td>${done}/${courseTasks.length}</td>
      <td class="text-nowrap">${accHtml(acc.get(en.alumna_id))}</td>
      <td class="text-end text-nowrap"><button class="btn btn-sm btn-outline-secondary" data-reset-pass="${esc(en.alumna_id)}" title="Cambiar contraseña"><i class="bi bi-key"></i></button>
      <button class="btn btn-sm btn-outline-danger" data-remove-enroll="${esc(en.id)}" title="Quitar del curso"><i class="bi bi-person-dash"></i></button></td></tr>`;
  });
  const withPct = [...acc.values()].filter((a) => a.pct !== null);
  const avgCourse = withPct.length ? Math.round(withPct.reduce((x, a) => x + a.pct, 0) / withPct.length) : null;
  const filters = `<div class="d-flex flex-wrap align-items-center gap-2 mb-3">
      <div class="input-icon flex-grow-1" style="max-width:340px"><i class="bi bi-search"></i><input class="form-control form-control-sm" id="studentSearch" placeholder="Buscar por nombre, clave o usuario"></div>
      <label class="small muted ms-sm-auto">Ordenar por</label>
      <select class="form-select form-select-sm" id="studentsSort" style="width:auto">
        <option value="clave" ${studentsSort === 'clave' ? 'selected' : ''}>Clave</option>
        <option value="apellido" ${studentsSort === 'apellido' ? 'selected' : ''}>Apellido</option>
        <option value="nota" ${studentsSort === 'nota' ? 'selected' : ''}>Nota acumulada (mayor a menor)</option>
        ${hasV5 ? `<option value="grupo" ${studentsSort === 'grupo' ? 'selected' : ''}>Grupo</option>` : ''}
      </select>
      ${avgCourse !== null ? `<span class="small muted">Promedio del curso: <strong>${avgCourse}%</strong></span>` : ''}</div>`;
  $('#mainContent').innerHTML = header(`<button class="btn btn-outline-primary" data-action="enroll"><i class="bi bi-person-check me-1"></i>Inscribir alumna</button>`) + toolbar + `
    <div class="surface-card">${filters}<div class="table-responsive">${rows.length ? `<table class="table table-hover align-middle mb-0"><thead><tr><th class="text-center" style="width:70px">Clave</th><th>Alumna</th><th>Usuario</th>${hasV5 ? '<th>Grupo</th>' : ''}<th>Entregas</th><th title="Tareas calificadas más tareas vencidas sin entregar (cuentan 0)">Nota acumulada <i class="bi bi-info-circle"></i></th><th></th></tr></thead><tbody>${rows.join('')}</tbody></table>` : empty('Este curso no tiene alumnas. Comparte el código de clase o inscríbelas tú.')}</div>
    <p class="small muted mt-3 mb-0"><i class="bi bi-info-circle me-1"></i>La nota acumulada suma las tareas ya calificadas y las vencidas sin entregar (cuentan 0). Las entregadas que aún no calificas no cuentan todavía.</p></div>`;
}

function groupsPanel(c, list, courseTasks) {
  const gs = groupsOf(c.id);
  const groupTasks = courseTasks.filter(isGroupTask);
  const loose = list.filter((en) => !groupOf(en.alumna_id, c.id));
  const cards = gs.map((g) => {
    const ms = membersOf(g.id);
    const lines = groupTasks.map((t) => {
      const grs = ms.map((m) => gradeFor(submissionOf(t.id, m.alumna_id)?.id)).filter(Boolean);
      const val = grs.length ? `${num(grs.reduce((x, y) => x + Number(y.nota), 0) / grs.length)} / ${esc(t.puntos_maximos)}` : '<span class="muted">Sin calificar</span>';
      return `<div class="d-flex justify-content-between small py-1 border-bottom"><span class="text-truncate me-2">${esc(t.titulo)}</span><strong class="text-nowrap">${val}</strong></div>`;
    }).join('');
    const pcts = ms.map((m) => accumulated(m.alumna_id, c.id).pct).filter((x) => x !== null);
    const avg = pcts.length ? `${Math.round(pcts.reduce((x, y) => x + y, 0) / pcts.length)}%` : '—';
    return `<div class="col-md-6 col-xl-4"><div class="surface-card h-100 d-flex flex-column">
      <div class="d-flex justify-content-between align-items-start mb-2"><div><h5 class="fw-bold mb-0">${esc(g.nombre)}</h5><div class="small muted">${ms.length} integrantes · promedio ${avg}</div></div>
        <div class="text-nowrap"><button class="btn btn-sm btn-outline-secondary" data-edit-group="${esc(g.id)}" title="Editar grupo"><i class="bi bi-pencil"></i></button> <button class="btn btn-sm btn-outline-danger" data-delete-group="${esc(g.id)}" title="Eliminar grupo"><i class="bi bi-trash"></i></button></div></div>
      <div class="mb-3">${ms.map((m) => `<div class="d-flex align-items-center gap-2 py-1">${avatarHtml(m.usuarios)}<span class="small"><span class="muted">${esc(m.usuarios?.clave ?? '')}</span> ${esc(listName(m.usuarios))}</span></div>`).join('') || '<span class="small muted">Sin integrantes</span>'}</div>
      <div class="mt-auto"><div class="small fw-bold mb-1">Notas del grupo</div>${lines || '<div class="small muted">Aún no hay tareas en grupo en este curso.</div>'}</div>
    </div></div>`;
  }).join('');
  const settings = hasV6(c) ? `<div class="surface-card mb-3 d-flex flex-wrap align-items-center gap-3">
      <div class="form-check form-switch mb-0"><input class="form-check-input" type="checkbox" role="switch" id="groupsOpen" ${c.grupos_abiertos ? 'checked' : ''}>
        <label class="form-check-label fw-semibold" for="groupsOpen">Las alumnas pueden elegir su grupo</label></div>
      <div class="d-flex align-items-center gap-2"><label class="small muted" for="groupsMax">Máximo por grupo</label><input type="number" class="form-control form-control-sm" id="groupsMax" min="1" max="50" value="${esc(c.max_por_grupo)}" style="width:80px"></div>
      <button class="btn btn-sm btn-outline-primary" data-save-group-settings>Guardar</button>
      <span class="small muted ms-lg-auto">${c.grupos_abiertos ? '<i class="bi bi-unlock me-1"></i>Abierto: ellas crean, se unen o se cambian de grupo.' : '<i class="bi bi-lock me-1"></i>Cerrado: solo tú armas los grupos.'}</span></div>`
    : '<p class="small text-warning">Para que las alumnas elijan su grupo ejecuta migracion-v6 en Supabase.</p>';
  return `${settings}<div class="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-3">
      <p class="muted mb-0">${loose.length ? `${loose.length} alumnas todavía sin grupo.` : 'Todas las alumnas tienen grupo.'} Las notas de las tareas "En grupo" se ven aquí.</p>
      <button class="btn btn-primary" data-new-group><i class="bi bi-plus-lg me-1"></i>Nuevo grupo</button></div>
    ${gs.length ? `<div class="row g-3">${cards}</div>` : empty('Todavía no hay grupos en este curso.')}`;
}

// Crear / editar grupo
function openGroupModal(groupId = null) {
  const c = course(studentsCourse);
  if (!c) return;
  editingGroup = groupId ? groups.find((g) => g.id === groupId) : null;
  const f = $('#groupForm');
  f.reset();
  f.elements.id.value = editingGroup?.id || '';
  f.elements.nombre.value = editingGroup?.nombre || `Grupo ${groupsOf(c.id).length + 1}`;
  $('#groupModalTitle').textContent = editingGroup ? 'Editar grupo' : 'Nuevo grupo';
  const mine = new Set(editingGroup ? membersOf(editingGroup.id).map((m) => m.alumna_id) : []);
  $('#groupMembers').innerHTML = studentsOf(c.id).map((en) => {
    const other = groupOf(en.alumna_id, c.id);
    const taken = other && other.id !== editingGroup?.id;
    return `<label class="group-option ${taken ? 'taken' : ''}"><input type="checkbox" class="form-check-input" value="${esc(en.alumna_id)}" ${mine.has(en.alumna_id) ? 'checked' : ''} ${taken ? 'disabled' : ''}>
      <span class="muted">${esc(en.usuarios?.clave ?? '')}</span> <span>${esc(listName(en.usuarios))}</span>${taken ? `<span class="ms-auto small muted">${esc(other.nombre)}</span>` : ''}</label>`;
  }).join('') || '<p class="muted small">Este curso no tiene alumnas.</p>';
  updateGroupCount();
  modal('#groupModal').show();
}
function updateGroupCount() { $('#groupCount').textContent = `${$('#groupMembers').querySelectorAll('input:checked').length} seleccionadas`; }
$('#groupMembers').addEventListener('change', updateGroupCount);

$('#groupForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const c = course(studentsCourse);
  const nombre = e.target.elements.nombre.value.trim();
  const chosen = [...$('#groupMembers').querySelectorAll('input:checked')].map((i) => i.value);
  if (!chosen.length) return notify('Elige al menos una integrante.', 'warning');
  await busy($('#groupSubmitBtn'), async () => {
    let groupId = editingGroup?.id;
    if (groupId) {
      const r = await db.from('grupos').update({ nombre }).eq('id', groupId);
      if (r.error) return notify(errMsg(r.error), 'danger');
      const before = membersOf(groupId).map((m) => m.alumna_id);
      const removed = before.filter((id) => !chosen.includes(id));
      if (removed.length) {
        const d = await db.from('grupo_integrantes').delete().eq('grupo_id', groupId).in('alumna_id', removed);
        if (d.error) return notify(errMsg(d.error), 'danger');
      }
      const added = chosen.filter((id) => !before.includes(id));
      if (added.length) {
        const i = await db.from('grupo_integrantes').insert(added.map((alumna_id) => ({ grupo_id: groupId, alumna_id })));
        if (i.error) return notify(errMsg(i.error), 'danger');
      }
    } else {
      const r = await db.from('grupos').insert({ curso_id: c.id, nombre }).select().single();
      if (r.error) return notify(/duplicate|unique/i.test(r.error.message) ? 'Ya existe un grupo con ese nombre.' : errMsg(r.error), 'danger');
      groupId = r.data.id;
      const i = await db.from('grupo_integrantes').insert(chosen.map((alumna_id) => ({ grupo_id: groupId, alumna_id })));
      if (i.error) { await db.from('grupos').delete().eq('id', groupId); return notify(errMsg(i.error), 'danger'); }
    }
    modal('#groupModal').hide();
    notify('Grupo guardado.');
    studentsTab = 'grupos';
    await refresh(true);
  });
});

async function saveGroupSettings(btn) {
  const c = course(studentsCourse);
  const max = Number($('#groupsMax').value);
  if (!Number.isInteger(max) || max < 1 || max > 50) return notify('El máximo debe ser un número entre 1 y 50.', 'warning');
  await busy(btn, async () => {
    const r = await db.from('cursos').update({ grupos_abiertos: $('#groupsOpen').checked, max_por_grupo: max }).eq('id', c.id);
    if (r.error) return notify(errMsg(r.error), 'danger');
    notify($('#groupsOpen').checked ? 'Listo: las alumnas ya pueden elegir su grupo.' : 'Elección de grupos cerrada.');
    await refresh(true);
  });
}

// La alumna elige, crea o deja su grupo
function openChooseGroup(courseId) {
  choosingCourse = courseId;
  renderChooseGroup();
  modal('#chooseGroupModal').show();
}
function renderChooseGroup() {
  const c = course(choosingCourse);
  if (!c) return;
  const mine = groupOf(me.id, c.id);
  const gs = groupsOf(c.id);
  $('#chooseGroupTitle').textContent = `Grupos · ${c.nombre}`;
  const list = gs.map((g) => {
    const ms = membersOf(g.id);
    const full = ms.length >= c.max_por_grupo;
    const isMine = mine?.id === g.id;
    const btn = isMine
      ? '<button class="btn btn-sm btn-outline-danger" data-leave-group>Salir</button>'
      : `<button class="btn btn-sm btn-primary" data-join-group="${esc(g.id)}" ${full ? 'disabled' : ''}>${full ? 'Lleno' : mine ? 'Cambiarme' : 'Unirme'}</button>`;
    return `<div class="choose-group ${isMine ? 'mine' : ''}"><div class="d-flex justify-content-between align-items-center mb-1">
        <div><strong>${esc(g.nombre)}</strong>${isMine ? ' <span class="badge-soft pill-green">Tu grupo</span>' : ''}</div>
        <div class="d-flex align-items-center gap-2"><span class="small muted">${ms.length}/${esc(c.max_por_grupo)}</span>${btn}</div></div>
      <div class="small muted">${ms.map((m) => esc(fullName(m.usuarios))).join(' · ') || 'Sin integrantes'}</div></div>`;
  }).join('');
  $('#chooseGroupBody').innerHTML = `${!c.grupos_abiertos ? '<div class="alert alert-warning small">Tu docente cerró la elección de grupos.</div>' : ''}
    <p class="small muted">Únete al grupo de tus compañeras o crea uno nuevo. Máximo ${esc(c.max_por_grupo)} integrantes por grupo.</p>
    ${list || '<p class="muted">Todavía no hay grupos. ¡Crea el primero!</p>'}
    <form id="newOwnGroup" class="d-flex gap-2 mt-3"><input class="form-control" name="nombre" maxlength="100" required placeholder="Nombre del grupo nuevo"><button class="btn btn-outline-primary text-nowrap" type="submit"><i class="bi bi-plus-lg me-1"></i>Crear</button></form>
    ${mine ? '<p class="small muted mt-2 mb-0">Si creas un grupo nuevo o te unes a otro, saldrás de tu grupo actual.</p>' : ''}`;
}
async function groupAction(fn, okMsg) {
  const r = await fn();
  if (r.error) return notify(errMsg(r.error), 'danger');
  notify(okMsg);
  await refresh(true);
  renderChooseGroup();
}
$('#chooseGroupBody').addEventListener('click', (e) => {
  const join = e.target.closest('[data-join-group]');
  if (join) return groupAction(() => db.rpc('unirse_a_grupo', { p_grupo: join.dataset.joinGroup }), '¡Te uniste al grupo!');
  if (e.target.closest('[data-leave-group]') && confirm('¿Salir de tu grupo?')) {
    return groupAction(() => db.rpc('salir_de_grupo', { p_curso: choosingCourse }), 'Saliste del grupo.');
  }
});
$('#chooseGroupBody').addEventListener('submit', (e) => {
  e.preventDefault();
  const nombre = e.target.elements.nombre.value.trim();
  if (nombre) groupAction(() => db.rpc('crear_grupo_alumna', { p_curso: choosingCourse, p_nombre: nombre }), 'Grupo creado. Ya eres parte de él.');
});

async function deleteGroup(id) {
  const g = groups.find((x) => x.id === id);
  if (!g || !confirm(`¿Eliminar "${g.nombre}"?\n\nLas alumnas quedan sin grupo. Las notas que ya tienen se conservan.`)) return;
  const r = await db.from('grupos').delete().eq('id', id);
  if (r.error) return notify(errMsg(r.error), 'danger');
  notify('Grupo eliminado.');
  await refresh(true);
}

function renderNotices() {
  setTitle('Avisos');
  const teacher = isTeacher();
  $('#mainContent').innerHTML = `<div class="d-flex justify-content-between align-items-center mb-4"><h4 class="section-heading mb-0">Tablón de anuncios</h4>${teacher ? '<button class="btn btn-primary" data-action="new-notice"><i class="bi bi-plus-lg me-1"></i>Nuevo aviso</button>' : ''}</div>
    ${notices.length ? notices.map((n) => `<div class="surface-card mb-3"><div class="d-flex gap-3"><div class="task-symbol"><i class="bi bi-megaphone"></i></div><div class="flex-grow-1"><h5 class="fw-bold mb-1">${esc(n.titulo)}</h5><div class="small muted mb-2">${esc(courseName(n.curso_id))} · ${esc(fmt(n.creado_en))}</div>${pre(n.contenido)}</div>${teacher ? `<div><button class="btn btn-sm btn-link text-danger" data-delete-notice="${esc(n.id)}" title="Eliminar aviso"><i class="bi bi-trash"></i></button></div>` : ''}</div></div>`).join('') : empty('No hay avisos publicados.')}`;
}

// =====================================================================
// VENTANAS (abrir)
// =====================================================================
const courseOptions = () => courses.map((c) => `<option value="${esc(c.id)}">${esc(c.nombre)} · ${esc(c.seccion)}</option>`).join('');

function openTaskModal(taskId = null, courseId = null) {
  if (!courses.length) { notify('Primero crea un curso.', 'warning'); return; }
  const f = $('#taskForm');
  f.reset();
  $('#taskCourse').innerHTML = courseOptions();
  const t = taskId ? task(taskId) : null;
  f.elements.id.value = t?.id || '';
  $('#taskModalTitle').textContent = t ? 'Editar tarea' : 'Publicar nueva tarea';
  $('#taskSubmitBtn').textContent = t ? 'Guardar cambios' : 'Publicar tarea';
  $('#taskFilesHint').textContent = t && materialsFor(t.id).length ? `Ya tiene ${materialsFor(t.id).length} archivo(s). Los nuevos se agregan; para quitar uno usa el ícono de basura en la tarea.` : '';
  if (t) {
    f.elements.curso_id.value = t.curso_id;
    f.elements.tipo.value = t.tipo || 'tarea';
    f.elements.modalidad.value = t.modalidad || 'individual';
    f.elements.titulo.value = t.titulo;
    f.elements.descripcion.value = t.descripcion;
    f.elements.instrucciones.value = t.instrucciones || '';
    f.elements.puntos_maximos.value = t.puntos_maximos;
    f.elements.fecha_limite.value = toLocalInput(t.fecha_limite);
    f.elements.permite_entrega_tardia.checked = t.permite_entrega_tardia;
  } else if (courseId) {
    f.elements.curso_id.value = courseId;
  }
  f.elements.modalidad.closest('div').classList.toggle('d-none', !hasV5);
  f.elements.tipo.querySelector('[value="exposicion"]').disabled = !hasV5;
  $('#taskExpoHint').classList.toggle('d-none', f.elements.tipo.value !== 'exposicion');
  modal('#taskModal').show();
}

async function renderExistingSubmitFiles() {
  const s = submittingTask && mySubmission(submittingTask.id);
  const list = s ? filesFor(s.id) : [];
  $('#submitExistingWrap').classList.toggle('d-none', !list.length);
  $('#submitExistingFiles').innerHTML = list.length ? await fileListHtml(list, 'data-delete-file') : '';
}
function openSubmitModal(taskId) {
  submittingTask = task(taskId);
  if (!submittingTask) return;
  const existing = mySubmission(taskId);
  const f = $('#submitForm');
  f.reset();
  $('#submitTaskTitle').textContent = submittingTask.titulo;
  f.elements.contenido.value = existing?.contenido || '';
  f.elements.enlace.value = existing?.enlace || '';
  $('#submitBtn').textContent = existing ? 'Guardar cambios' : 'Enviar entrega';
  $('#submitTextFields').classList.toggle('d-none', isExpo(submittingTask));
  $('#submitExpoHint').classList.toggle('d-none', !isExpo(submittingTask));
  renderExistingSubmitFiles();
  modal('#submitModal').show();
}

function openGradeModal(subId) {
  const s = submissions.find((x) => x.id === subId);
  if (!s) return;
  gradingSubmission = s;
  const t = task(s.tarea_id);
  const g = gradeFor(s.id);
  $('#gradeStudentName').textContent = `${studentName(s.alumna_id)} · Máximo ${t?.puntos_maximos || 100} puntos`;
  $('#gradeValue').max = t?.puntos_maximos || 100;
  $('#gradeForm').elements.nota.value = g?.nota ?? '';
  $('#gradeForm').elements.comentario.value = g?.comentario || '';
  modal('#gradeModal').show();
}

function openCourseModal(courseId = null) {
  const f = $('#courseForm');
  f.reset();
  const c = courseId ? course(courseId) : null;
  f.elements.id.value = c?.id || '';
  $('#courseModalTitle').textContent = c ? 'Editar curso' : 'Crear curso';
  $('#courseSubmitBtn').textContent = c ? 'Guardar cambios' : 'Crear curso';
  $('#courseModalHint').classList.toggle('d-none', !!c);
  $('#archiveCourseBtn').classList.toggle('d-none', !c);
  if (c) {
    f.elements.nombre.value = c.nombre;
    f.elements.grado.value = c.grado;
    f.elements.seccion.value = c.seccion;
    f.elements.descripcion.value = c.descripcion || '';
  }
  $('#coverInput').disabled = !hasV5;
  $('#coverRemoveWrap').classList.toggle('d-none', !c?.portada);
  modal('#courseModal').show();
}

function openNoticeModal() {
  if (!courses.length) { notify('Primero crea un curso.', 'warning'); return; }
  $('#noticeForm').reset();
  $('#noticeCourse').innerHTML = courseOptions();
  modal('#noticeModal').show();
}
function openEnrollModal() {
  const c = course(studentsCourse);
  if (!c) return;
  $('#enrollForm').reset();
  $('#enrollCourseName').textContent = `Curso: ${c.nombre} · Sección ${c.seccion}`;
  modal('#enrollModal').show();
}
function openAccountModal() {
  $('#accountForm').reset();
  $('#accountResult').classList.add('d-none');
  $('#accountCourse').innerHTML = `<option value="">— Ninguno por ahora —</option>${courseOptions()}`;
  if (view === 'alumnas' && course(studentsCourse)) $('#accountCourse').value = studentsCourse;
  $('#accountPassword').value = generatePassword();
  modal('#accountModal').show();
}
function openPasswordModal(alumnaId) {
  const f = $('#passwordForm');
  f.reset();
  f.elements.alumna_id.value = alumnaId;
  $('#passwordStudentName').textContent = studentName(alumnaId);
  $('#newPassword').value = generatePassword();
  modal('#passwordModal').show();
}

// =====================================================================
// ACCIONES
// =====================================================================
async function uploadMaterials(taskId, list) {
  const failed = [];
  for (const file of list) {
    const path = `material/${taskId}/${crypto.randomUUID()}-${safeName(file.name)}`;
    const up = await db.storage.from(BUCKET).upload(path, file, { upsert: false, contentType: mimeFor(file.name) });
    if (up.error) { failed.push(`${file.name}: ${up.error.message}`); continue; }
    const meta = await db.from('archivos_tarea').insert({ tarea_id: taskId, nombre_archivo: file.name, ruta_storage: path, tipo_archivo: mimeFor(file.name), tamano_bytes: file.size });
    if (meta.error) { failed.push(`${file.name}: ${meta.error.message}`); await db.storage.from(BUCKET).remove([path]); }
  }
  return failed;
}

async function deleteMaterial(id) {
  const m = materials.find((x) => x.id === id);
  if (!m || !confirm(`¿Quitar "${m.nombre_archivo}" del material de la tarea?`)) return;
  const r = await db.from('archivos_tarea').delete().eq('id', id);
  if (r.error) return notify(r.error.message, 'danger');
  await db.storage.from(BUCKET).remove([m.ruta_storage]);
  notify('Archivo quitado.');
  await refresh();
}

async function deleteSubmissionFile(id) {
  const f = files.find((x) => x.id === id);
  if (!f || !confirm(`¿Quitar "${f.nombre_archivo}" de tu entrega?`)) return;
  const r = await db.from('archivos_entrega').delete().eq('id', id);
  if (r.error) return notify(errMsg(r.error), 'danger');
  await db.storage.from(BUCKET).remove([f.ruta_storage]);
  files = files.filter((x) => x.id !== id);
  await renderExistingSubmitFiles();
  notify('Archivo quitado.');
  render();
}

async function deleteTask(id) {
  const t = task(id);
  if (!t) return;
  const n = submissions.filter((s) => s.tarea_id === id).length;
  if (!confirm(`¿Eliminar la tarea "${t.titulo}"?${n ? `\n\nSe borrarán también ${n} entrega(s) y sus calificaciones.` : ''}\nEsta acción no se puede deshacer.`)) return;
  const paths = materialsFor(id).map((m) => m.ruta_storage);
  const r = await db.from('tareas').delete().eq('id', id);
  if (r.error) return notify(errMsg(r.error), 'danger');
  if (paths.length) await db.storage.from(BUCKET).remove(paths);
  notify('Tarea eliminada.');
  view = 'tareas'; viewArg = null;
  await refresh();
}

async function deleteNotice(id) {
  if (!confirm('¿Eliminar este aviso?')) return;
  const r = await db.from('anuncios').delete().eq('id', id);
  if (r.error) return notify(errMsg(r.error), 'danger');
  notify('Aviso eliminado.');
  await refresh();
}

async function removeEnrollment(id) {
  const en = enrollments.find((x) => x.id === id);
  if (!en || !confirm(`¿Quitar a ${fullName(en.usuarios)} de ${courseName(en.curso_id)}?\nSus entregas se conservan.`)) return;
  const r = await db.from('inscripciones').delete().eq('id', id);
  if (r.error) return notify(errMsg(r.error), 'danger');
  notify('Alumna quitada del curso.');
  await refresh();
}

// =====================================================================
// EVENTOS
// =====================================================================
$('#togglePassword').onclick = () => { const p = $('#password'); p.type = p.type === 'password' ? 'text' : 'password'; };

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!db) return notify('Primero configura Supabase.', 'warning');
  const username = $('#username').value.trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,50}$/.test(username)) return notify('Usuario no válido.', 'warning');
  await busy($('#loginBtn'), async () => {
    try {
      const { data, error } = await db.auth.signInWithPassword({ email: `${username}@${LOGIN_DOMAIN}`, password: $('#password').value });
      if (error) throw error;
      await loadProfile(data.user.id);
    } catch (err) {
      console.error(err);
      notify('Usuario o contraseña incorrectos, o cuenta sin acceso.', 'danger');
    }
  });
});

$('#logoutBtn').onclick = async () => {
  await db.auth.signOut();
  me = null; courses = []; tasks = []; submissions = []; grades = []; notices = []; enrollments = []; files = []; materials = [];
  readings = []; readingFiles = []; queries = []; queryMsgs = [];
  showLogin();
};
$('#homeLink').onclick = (e) => { e.preventDefault(); navigate('inicio'); };
$('#sideNav').onclick = (e) => { const b = e.target.closest('[data-view]'); if (b) navigate(b.dataset.view); };
$('#menuBtn').onclick = () => { $('#sidebar').classList.toggle('open'); $('#mobileShade').classList.toggle('d-none'); };
$('#mobileShade').onclick = () => { $('#sidebar').classList.remove('open'); $('#mobileShade').classList.add('d-none'); };

// Botones "Generar" contraseña
document.addEventListener('click', (e) => {
  const g = e.target.closest('[data-generate-password]');
  if (g) $(g.dataset.generatePassword).value = generatePassword();
});

// Clics dentro del contenido principal
$('#mainContent').addEventListener('click', (e) => {
  const el = (sel) => e.target.closest(sel);
  let b;
  if ((b = el('[data-action]'))) {
    const a = b.dataset.action;
    if (a === 'new-task') openTaskModal(null, view === 'tareas' ? viewArg : null);
    else if (a === 'new-course') openCourseModal();
    else if (a === 'join') { $('#joinForm').reset(); modal('#joinModal').show(); }
    else if (a === 'new-notice') openNoticeModal();
    else if (a === 'enroll') openEnrollModal();
    else if (a === 'create-account') openAccountModal();
    else if (a === 'new-material') openMaterialModal(materialCourse || null);
    else if (a === 'new-query') openQueryModal();
    return;
  }
  if ((b = el('[data-submit-task]'))) return openSubmitModal(b.dataset.submitTask);
  if (handleV7Click(el)) return;
  if ((b = el('[data-edit-task]'))) return openTaskModal(b.dataset.editTask);
  if ((b = el('[data-delete-task]'))) return deleteTask(b.dataset.deleteTask);
  if ((b = el('[data-delete-material]'))) return deleteMaterial(b.dataset.deleteMaterial);
  if ((b = el('[data-delete-notice]'))) return deleteNotice(b.dataset.deleteNotice);
  if ((b = el('[data-remove-enroll]'))) return removeEnrollment(b.dataset.removeEnroll);
  if ((b = el('[data-reset-pass]'))) return openPasswordModal(b.dataset.resetPass);
  if ((b = el('[data-grade]'))) return openGradeModal(b.dataset.grade);
  if ((b = el('[data-quick-alumna], [data-quick-group]'))) return quickGrade(b);
  if ((b = el('[data-new-group]'))) return openGroupModal();
  if ((b = el('[data-save-group-settings]'))) return saveGroupSettings(b);
  if ((b = el('[data-entregas-tab]'))) { entregasTab = b.dataset.entregasTab; return renderSubmissions(); }
  if ((b = el('[data-dash-bin]'))) { dashBin = b.dataset.dashBin && b.dataset.dashBin !== dashBin ? b.dataset.dashBin : null; return renderSubmissions(); }
  if ((b = el('[data-choose-group]'))) return openChooseGroup(b.dataset.chooseGroup);
  if ((b = el('[data-edit-group]'))) return openGroupModal(b.dataset.editGroup);
  if ((b = el('[data-delete-group]'))) return deleteGroup(b.dataset.deleteGroup);
  if ((b = el('[data-students-tab]'))) { studentsTab = b.dataset.studentsTab; return renderStudents(); }
  if ((b = el('[data-view-submission]'))) return navigate('entrega', b.dataset.viewSubmission);
  if ((b = el('[data-edit-course]'))) return openCourseModal(b.dataset.editCourse);
  if ((b = el('[data-course-students]'))) { studentsCourse = b.dataset.courseStudents; return navigate('alumnas'); }
  if ((b = el('[data-open-course]'))) return navigate('tareas', b.dataset.openCourse);
  if ((b = el('[data-copy-code]'))) {
    navigator.clipboard?.writeText(b.dataset.copyCode).then(() => notify('Código copiado.'), () => notify(`Código: ${b.dataset.copyCode}`, 'info'));
    return;
  }
  if ((b = el('[data-back]'))) { const [v, arg] = b.dataset.back.split(':'); return navigate(v, arg || null); }
  if (el('a')) return; // enlaces a archivos
  if ((b = el('[data-open-task]'))) return navigate('tarea', b.dataset.openTask);
});

$('#taskForm').elements.tipo.addEventListener('change', (e) => $('#taskExpoHint').classList.toggle('d-none', e.target.value !== 'exposicion'));

// Tooltip de las gráficas
const vizTip = Object.assign(document.createElement('div'), { className: 'viz-tip', role: 'tooltip' });
document.body.append(vizTip);
$('#mainContent').addEventListener('mousemove', (e) => {
  const m = e.target.closest('[data-tip]');
  if (!m) { vizTip.classList.remove('show'); return; }
  vizTip.textContent = m.dataset.tip;
  vizTip.classList.add('show');
  const x = Math.min(e.clientX + 14, window.innerWidth - vizTip.offsetWidth - 8);
  vizTip.style.transform = `translate(${x}px, ${e.clientY + 16}px)`;
});
$('#mainContent').addEventListener('mouseleave', () => vizTip.classList.remove('show'));

// Enter en la nota rápida = guardar
$('#mainContent').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || !e.target.matches('[data-q-nota], [data-q-com]')) return;
  e.preventDefault();
  e.target.closest('tr')?.querySelector('[data-quick-alumna], [data-quick-group]')?.click();
});
// Buscar alumna sin volver a dibujar la tabla
$('#mainContent').addEventListener('input', (e) => {
  if (e.target.id !== 'studentSearch') return;
  const q = e.target.value.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  document.querySelectorAll('[data-search]').forEach((tr) => tr.classList.toggle('d-none', q && !tr.dataset.search.includes(q)));
});

$('#mainContent').addEventListener('change', (e) => {
  if (e.target.id === 'studentsSort') { studentsSort = e.target.value; renderStudents(); }
  if (e.target.id === 'dashCourse') { dashCourse = e.target.value; dashBin = null; renderSubmissions(); }
  if (e.target.id === 'studentsCourseSelect') { studentsCourse = e.target.value; renderStudents(); }
  if (e.target.id === 'taskCourseFilter') navigate('tareas', e.target.value || null);
  if (e.target.id === 'materialCourseFilter') { materialCourse = e.target.value; renderMaterial(); }
  if (e.target.id === 'agendaCourseFilter') { agendaCourse = e.target.value; renderAgenda(); }
  if (e.target.id === 'homeCourseSearch' && e.target.value) navigate('tareas', e.target.value);
});

// Mi perfil y foto
function openProfileModal() {
  $('#profileName').textContent = fullName(me);
  $('#profileInfo').textContent = `${me.usuario} · ${isTeacher() ? 'Docente' : 'Alumna'}${me.clave ? ` · Clave ${me.clave}` : ''}`;
  $('#profileNote').textContent = isTeacher() ? 'Tu foto la ven tus alumnas.' : 'Tu foto solo la ven tú y tus docentes.';
  $('#photoRemoveBtn').classList.toggle('d-none', !me.foto);
  paintMyAvatar();
  modal('#profileModal').show();
}
document.addEventListener('click', (e) => { if (e.target.closest('[data-open-profile]')) openProfileModal(); });
$('#photoPickBtn').onclick = () => {
  if (!hasV4) return notify('Primero ejecuta migracion-v4-clave-foto.sql en Supabase.', 'warning');
  $('#photoInput').click();
};
$('#photoInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  if (!file.type.startsWith('image/')) return notify('Elige una imagen (JPG o PNG).', 'warning');
  await busy($('#photoPickBtn'), async () => {
    try {
      const blob = await resizeImage(file);
      const path = `${me.id}/${Date.now()}.jpg`;
      const up = await db.storage.from(PHOTO_BUCKET).upload(path, blob, { contentType: 'image/jpeg', upsert: false });
      if (up.error) throw up.error;
      const r = await db.from('usuarios').update({ foto: path }).eq('id', me.id);
      if (r.error) { await db.storage.from(PHOTO_BUCKET).remove([path]); throw r.error; }
      const old = me.foto;
      me.foto = path;
      if (old) await db.storage.from(PHOTO_BUCKET).remove([old]);
      await loadPhotos([me]);
      paintMyAvatar();
      $('#photoRemoveBtn').classList.remove('d-none');
      notify('Foto actualizada.');
    } catch (err) {
      console.error(err);
      notify(`No se pudo guardar la foto: ${err.message}`, 'danger');
    }
  });
});
$('#photoRemoveBtn').onclick = async () => {
  if (!me.foto || !confirm('¿Quitar tu foto de perfil?')) return;
  const old = me.foto;
  const r = await db.from('usuarios').update({ foto: null }).eq('id', me.id);
  if (r.error) return notify(errMsg(r.error), 'danger');
  await db.storage.from(PHOTO_BUCKET).remove([old]);
  me.foto = null;
  paintMyAvatar();
  $('#photoRemoveBtn').classList.add('d-none');
  notify('Foto quitada.');
};

// Quitar archivo desde la ventana de entrega
$('#submitExistingFiles').addEventListener('click', (e) => {
  const b = e.target.closest('[data-delete-file]');
  if (b) deleteSubmissionFile(b.dataset.deleteFile);
});

// Crear / editar tarea
$('#taskForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const f = new FormData(form);
  const id = f.get('id');
  const fecha = new Date(f.get('fecha_limite'));
  if (!Number.isFinite(fecha.getTime())) return notify('Selecciona una fecha límite válida.', 'warning');
  if (!id && fecha <= new Date()) return notify('Selecciona una fecha límite futura.', 'warning');
  const newFiles = [...$('#taskFiles').files];
  const bad = checkFiles(newFiles);
  if (bad) return notify(bad, 'warning');

  const payload = {
    curso_id: f.get('curso_id'),
    tipo: f.get('tipo'),
    ...(hasV5 ? { modalidad: f.get('modalidad') } : {}),
    titulo: f.get('titulo').trim(),
    descripcion: f.get('descripcion').trim(),
    instrucciones: f.get('instrucciones').trim() || null,
    puntos_maximos: Number(f.get('puntos_maximos')),
    fecha_limite: fecha.toISOString(),
    permite_entrega_tardia: form.elements.permite_entrega_tardia.checked,
  };
  await busy($('#taskSubmitBtn'), async () => {
    const r = id
      ? await db.from('tareas').update(payload).eq('id', id).select().single()
      : await db.from('tareas').insert({ ...payload, publicada: true }).select().single();
    if (r.error) return notify(errMsg(r.error), 'danger');
    const failed = newFiles.length ? await uploadMaterials(r.data.id, newFiles) : [];
    modal('#taskModal').hide();
    if (failed.length) notify(`La tarea se guardó, pero algunos archivos no: ${failed.join('; ')}`, 'warning', 9000);
    else notify(id ? 'Tarea actualizada.' : 'Tarea publicada correctamente.');
    view = 'tarea'; viewArg = r.data.id;
    await refresh();
  });
});

// Entregar / actualizar entrega
$('#submitForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!submittingTask) return;
  const f = new FormData(e.target);
  const content = String(f.get('contenido') || '').trim();
  const link = String(f.get('enlace') || '').trim();
  const newFiles = [...$('#submissionFile').files];
  if (link && !safeHttpUrl(link)) return notify('El enlace debe empezar con https:// o http://.', 'warning');
  const existing = mySubmission(submittingTask.id);
  const kept = existing ? filesFor(existing.id).length : 0;
  if (isExpo(submittingTask) && !newFiles.length && !kept) return notify('Selecciona el archivo de tu presentación.', 'warning');
  if (!content && !link && !newFiles.length && !kept) return notify('Escribe una respuesta, agrega un enlace o selecciona un archivo.', 'warning');
  const bad = checkFiles(newFiles);
  if (bad) return notify(bad, 'warning');

  await busy($('#submitBtn'), async () => {
    const r = existing
      ? await db.from('entregas').update({ contenido: content || null, enlace: link || null }).eq('id', existing.id).select().single()
      : await db.from('entregas').insert({ tarea_id: submittingTask.id, alumna_id: me.id, contenido: content || null, enlace: link || null }).select().single();
    if (r.error) return notify(errMsg(r.error), 'danger');
    const delivery = r.data;
    const failed = [];
    for (const file of newFiles) {
      const path = `${me.id}/${delivery.id}/${crypto.randomUUID()}-${safeName(file.name)}`;
      const up = await db.storage.from(BUCKET).upload(path, file, { upsert: false, contentType: mimeFor(file.name) });
      if (up.error) { failed.push(`${file.name}: ${up.error.message}`); continue; }
      const meta = await db.from('archivos_entrega').insert({ entrega_id: delivery.id, nombre_archivo: file.name, ruta_storage: path, tipo_archivo: mimeFor(file.name), tamano_bytes: file.size });
      if (meta.error) { failed.push(`${file.name}: ${meta.error.message}`); await db.storage.from(BUCKET).remove([path]); }
    }
    modal('#submitModal').hide();
    if (failed.length) notify(`La entrega se guardó, pero algunos archivos no: ${failed.join('; ')}`, 'warning', 9000);
    else notify('¡Entrega guardada correctamente!');
    await refresh();
  });
});

// Calificar
$('#gradeForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!gradingSubmission) return;
  const s = gradingSubmission;
  const current = gradeFor(s.id);
  const nota = Number(e.target.elements.nota.value);
  const comentario = e.target.elements.comentario.value.trim() || null;
  const r = current
    ? await db.from('calificaciones').update({ nota, comentario }).eq('id', current.id)
    : await db.from('calificaciones').insert({ entrega_id: s.id, docente_id: me.id, nota, comentario });
  if (r.error) return notify(errMsg(r.error), 'danger');
  modal('#gradeModal').hide();
  notify('Calificación guardada.');
  await refresh();
});

// Crear / editar curso
$('#courseForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const id = f.get('id');
  const payload = {
    nombre: f.get('nombre').trim(), grado: f.get('grado').trim(), seccion: f.get('seccion').trim(),
    descripcion: f.get('descripcion').trim() || null,
  };
  await busy($('#courseSubmitBtn'), async () => {
    const r = id
      ? await db.from('cursos').update(payload).eq('id', id).select().single()
      : await db.from('cursos').insert({ ...payload, docente_id: me.id }).select().single();
    if (r.error) return notify(errMsg(r.error), 'danger');
    const coverMsg = await saveCover(r.data, $('#coverInput').files[0], $('#coverRemove').checked);
    if (coverMsg) notify(coverMsg, 'warning', 8000);
    modal('#courseModal').hide();
    if (id) notify('Curso actualizado.');
    else notify(r.data.codigo_clase ? `Curso creado. Código de clase: ${r.data.codigo_clase}` : 'Curso creado.', 'success', 8000);
    if (!id) { view = 'cursos'; viewArg = null; }
    await refresh();
  });
});

// Foto de portada del curso (formato 3:1, unos 100 KB)
async function saveCover(c, file, remove) {
  if (!hasV5 || (!file && !remove)) return null;
  const old = c.portada;
  try {
    if (file) {
      if (!file.type.startsWith('image/')) return 'La portada debe ser una imagen (JPG o PNG).';
      const blob = await resizeImage(file, 1200, 400);
      const path = `${c.id}/${Date.now()}.jpg`;
      const up = await db.storage.from(COVER_BUCKET).upload(path, blob, { contentType: 'image/jpeg', upsert: false });
      if (up.error) throw up.error;
      const r = await db.from('cursos').update({ portada: path }).eq('id', c.id);
      if (r.error) { await db.storage.from(COVER_BUCKET).remove([path]); throw r.error; }
    } else {
      const r = await db.from('cursos').update({ portada: null }).eq('id', c.id);
      if (r.error) throw r.error;
    }
    if (old) await db.storage.from(COVER_BUCKET).remove([old]);
    return null;
  } catch (err) {
    console.error(err);
    return `El curso se guardó, pero la portada no: ${err.message}`;
  }
}

// Archivar curso (deja de verse, pero no se borra nada)
$('#archiveCourseBtn').addEventListener('click', async () => {
  const id = $('#courseForm').elements.id.value;
  const c = course(id);
  if (!c || !confirm(`¿Archivar "${c.nombre}"?\n\nYa no aparecerá para ti ni para las alumnas. Las tareas, entregas y notas se conservan en la base de datos.`)) return;
  const r = await db.from('cursos').update({ activo: false }).eq('id', id);
  if (r.error) return notify(errMsg(r.error), 'danger');
  modal('#courseModal').hide();
  notify('Curso archivado.');
  await refresh();
});

// Publicar aviso
$('#noticeForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const r = await db.from('anuncios').insert({ curso_id: f.get('curso_id'), docente_id: me.id, titulo: f.get('titulo').trim(), contenido: f.get('contenido').trim() });
  if (r.error) return notify(errMsg(r.error), 'danger');
  modal('#noticeModal').hide();
  notify('Aviso publicado.');
  view = 'anuncios';
  await refresh();
});

// Unirse con código (alumna)
$('#joinForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const codigo = e.target.elements.codigo.value.trim().toUpperCase();
  const { error } = await db.rpc('unirse_a_curso', { p_codigo: codigo });
  if (error) return notify(errMsg(error), 'danger');
  modal('#joinModal').hide();
  notify('¡Te uniste a la clase!');
  view = 'cursos';
  await refresh();
});

// Inscribir alumna existente (docente)
$('#enrollForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const usuario = e.target.elements.usuario.value.trim().toLowerCase();
  const { error } = await db.rpc('inscribir_alumna', { p_curso: studentsCourse, p_usuario: usuario });
  if (error) return notify(errMsg(error), 'danger');
  modal('#enrollModal').hide();
  notify(`${usuario} quedó inscrita.`);
  await refresh();
});

// Crear cuenta (docente → Edge Function)
$('#accountForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const body = {
    accion: 'crear',
    usuario: f.get('usuario').trim().toLowerCase(),
    nombre: f.get('nombre').trim(),
    apellido: f.get('apellido').trim(),
    password: f.get('password'),
    curso_id: f.get('curso_id') || null,
  };
  await busy($('#accountBtn'), async () => {
    try {
      await callAdmin(body);
      const box = $('#accountResult');
      box.innerHTML = `<strong>Cuenta creada.</strong> Entrégale estos datos a ${esc(body.nombre)}:<br>Usuario: <code>${esc(body.usuario)}</code><br>Contraseña: <code>${esc(body.password)}</code>`;
      box.classList.remove('d-none');
      const keepCourse = e.target.elements.curso_id.value;
      e.target.reset();
      e.target.elements.curso_id.value = keepCourse;
      $('#accountPassword').value = generatePassword();
      await refresh();
    } catch (err) {
      notify(err.message, 'danger', 9000);
    }
  });
});

// Cambiar contraseña (docente → Edge Function)
$('#passwordForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  await busy($('#passwordBtn'), async () => {
    try {
      await callAdmin({ accion: 'contrasena', alumna_id: f.get('alumna_id'), password: f.get('password') });
      modal('#passwordModal').hide();
      notify(`Contraseña cambiada. Nueva contraseña: ${f.get('password')}`, 'success', 12000);
    } catch (err) {
      notify(err.message, 'danger', 9000);
    }
  });
});

$('#accountUser').addEventListener('input', (e) => { e.target.value = e.target.value.toLowerCase().replace(/\s+/g, '.'); });

// =====================================================================
// v7: MATERIAL DE LECTURA, CONSULTAS Y AGENDA
// =====================================================================
const READ_DIR = 'lectura';
const DIAS = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
const pad2 = (n) => String(n).padStart(2, '0');
const dayKey = (d) => { const x = new Date(d); return `${x.getFullYear()}-${pad2(x.getMonth() + 1)}-${pad2(x.getDate())}`; };
const fromKey = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const mondayOf = (d) => { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); return addDays(x, -((x.getDay() + 6) % 7)); };
const monthLabel = (d) => cap(new Intl.DateTimeFormat('es-GT', { month: 'long', year: 'numeric' }).format(d));
const timeLabel = (s) => new Intl.DateTimeFormat('es-GT', { hour: 'numeric', minute: '2-digit' }).format(new Date(s));
const longDay = (d) => cap(new Intl.DateTimeFormat('es-GT', { weekday: 'long', day: 'numeric', month: 'long' }).format(d));
const v7Missing = () => `<div class="alert alert-warning"><i class="bi bi-database-exclamation me-1"></i>Esta sección necesita la base de datos actualizada. Ejecuta <code>migracion-v7-material-consultas.sql</code> en Supabase &gt; SQL Editor y recarga la página.</div>`;

async function loadV7(ids) {
  const [mr, qr] = await Promise.all([
    db.from('materiales').select('*').in('curso_id', ids).order('creado_en', { ascending: false }),
    db.from('consultas').select(`*, usuarios:alumna_id(id,usuario,nombre,apellido${hasV4 ? ',clave,foto' : ''})`).in('curso_id', ids).order('actualizado_en', { ascending: false }),
  ]);
  if (mr.error || qr.error) {
    hasV7 = false;
    console.warn('Material/consultas no disponibles (¿falta migracion-v7?):', (mr.error || qr.error).message);
    return;
  }
  readings = mr.data || []; queries = qr.data || [];
  const [fr, msr] = await Promise.all([
    inChunks(readings.map((m) => m.id), (p) => db.from('archivos_material').select('*').in('material_id', p), byDate('creado_en')),
    inChunks(queries.map((q) => q.id), (p) => db.from('consulta_mensajes').select('*').in('consulta_id', p), byDate('creado_en')),
  ]);
  if (fr.error) console.warn(fr.error.message); else readingFiles = fr.data || [];
  if (msr.error) console.warn(msr.error.message); else queryMsgs = msr.data || [];
  if (isTeacher()) await loadPhotos(queries.map((q) => q.usuarios));
}

// ---------- Consultas: estado ----------
const msgsOf = (qId) => queryMsgs.filter((m) => m.consulta_id === qId);
const lastMsg = (q) => { const l = msgsOf(q.id); return l[l.length - 1]; };
function queryState(q) {
  if (q.resuelta) return 'resuelta';
  const l = lastMsg(q);
  return !l || l.autor_id === q.alumna_id ? 'espera' : 'respondida';
}
function queryBadge(q) {
  const st = queryState(q);
  if (st === 'resuelta') return badge('Resuelta', 'pill-green');
  if (st === 'espera') return badge(isTeacher() ? 'Sin responder' : 'Esperando respuesta', 'pill-orange');
  return badge(isTeacher() ? 'Respondida' : 'Tu docente respondió', 'pill-blue');
}
// Docente: consultas sin responder. Alumna: respuestas nuevas sin cerrar.
const openQueriesCount = () => queries.filter((q) => queryState(q) === (isTeacher() ? 'espera' : 'respondida')).length;
function paintQueryBadge() {
  const el = $('#queryBadge');
  if (!el) return;
  const n = hasV7 ? openQueriesCount() : 0;
  el.textContent = n;
  el.classList.toggle('d-none', !n);
}

// ---------- Calendario pequeño (inicio) ----------
function tasksOnDay(key, list = tasks) { return list.filter((t) => dayKey(t.fecha_limite) === key); }
function eventClass(t) {
  if (isTeacher()) return `ev-c${Math.max(0, courses.findIndex((c) => c.id === t.curso_id)) % 6}`;
  const s = mySubmission(t.id);
  if ((s && gradeFor(s.id)) || hasWork(s) || /grupo/.test(statusFor(t))) return 'ev-done';
  return isExpired(t) ? 'ev-late' : 'ev-open';
}
function miniCalendarHtml() {
  const y = miniRef.getFullYear(), m = miniRef.getMonth();
  const start = mondayOf(new Date(y, m, 1));
  const todayK = dayKey(new Date());
  let cells = '';
  for (let i = 0; i < 42; i++) {
    const d = addDays(start, i);
    if (i >= 35 && d.getMonth() !== m) break;
    const k = dayKey(d);
    const ts = tasksOnDay(k);
    cells += `<button class="mc-day ${d.getMonth() !== m ? 'out' : ''} ${k === todayK ? 'today' : ''} ${ts.length ? 'has' : ''}" data-agenda-day="${k}" ${ts.length ? `data-tip="${esc(ts.map((t) => t.titulo).join(' · '))}"` : ''}>${d.getDate()}${ts.length ? `<i class="${eventClass(ts[0])}"></i>` : ''}</button>`;
  }
  return `<div class="mini-cal"><div class="mc-head"><button class="mc-nav" data-mini-nav="-1" aria-label="Mes anterior"><i class="bi bi-chevron-left"></i></button><span>${esc(monthLabel(miniRef))}</span><button class="mc-nav" data-mini-nav="1" aria-label="Mes siguiente"><i class="bi bi-chevron-right"></i></button></div>
    <div class="mc-grid">${['L', 'M', 'M', 'J', 'V', 'S', 'D'].map((x) => `<span class="mc-dow">${x}</span>`).join('')}${cells}</div></div>`;
}

// ---------- Agenda ----------
function agendaChip(t, withTime = true) {
  return `<button class="ev-chip ${eventClass(t)}" data-open-task="${esc(t.id)}" data-tip="${esc(`${t.titulo} · ${courseName(t.curso_id)} · ${timeLabel(t.fecha_limite)}`)}">${withTime ? `<b>${esc(timeLabel(t.fecha_limite))}</b> ` : ''}${esc(t.titulo)}</button>`;
}
function agendaItem(t) {
  const extra = isTeacher()
    ? badge(`${submissions.filter((s) => s.tarea_id === t.id && hasWork(s)).length}/${studentsOf(t.curso_id).length} entregas`, 'pill-blue')
    : statusFor(t);
  return `<div class="ag-item clickable ${eventClass(t)}" data-open-task="${esc(t.id)}"><div class="ag-time">${esc(timeLabel(t.fecha_limite))}</div>
    <div class="flex-grow-1 min-w-0"><div class="fw-bold text-truncate">${esc(t.titulo)}</div><div class="small muted text-truncate">${esc(courseName(t.curso_id))} · ${esc(TIPOS[t.tipo] || 'Tarea')} · ${esc(t.puntos_maximos)} pts</div></div>
    <div class="text-nowrap">${extra}</div></div>`;
}
function renderAgenda() {
  setTitle('Agenda', 'Mi espacio');
  if (viewArg && /^\d{4}-\d{2}-\d{2}$/.test(viewArg)) { agendaRef = fromKey(viewArg); agendaDay = viewArg; viewArg = null; }
  if (agendaCourse && !course(agendaCourse)) agendaCourse = '';
  const list = tasks.filter((t) => !agendaCourse || t.curso_id === agendaCourse);
  const todayK = dayKey(new Date());
  const modes = [['mes', 'calendar3', 'Mes'], ['semana', 'calendar-week', 'Semana'], ['lista', 'list-ul', 'Agenda']];
  const label = agendaMode === 'mes' ? monthLabel(agendaRef)
    : agendaMode === 'semana' ? `Semana del ${new Intl.DateTimeFormat('es-GT', { day: 'numeric', month: 'short' }).format(mondayOf(agendaRef))}`
    : 'Próximas actividades';
  const legend = isTeacher()
    ? `<div class="viz-legend">${courses.map((c, i) => `<span><i class="sw ev-c${i % 6}"></i>${esc(c.nombre)}</span>`).join('')}</div>`
    : '<div class="viz-legend"><span><i class="sw ev-open"></i>Pendiente</span><span><i class="sw ev-done"></i>Entregada</span><span><i class="sw ev-late"></i>Vencida sin entregar</span></div>';
  const toolbar = `<div class="agenda-bar surface-card mb-3">
      <div class="d-flex align-items-center gap-2">${agendaMode !== 'lista' ? `<button class="btn icon-btn" data-agenda-nav="-1" aria-label="Anterior"><i class="bi bi-chevron-left"></i></button><button class="btn btn-sm btn-outline-primary" data-agenda-nav="0">Hoy</button><button class="btn icon-btn" data-agenda-nav="1" aria-label="Siguiente"><i class="bi bi-chevron-right"></i></button>` : ''}<h5 class="mb-0 ms-1">${esc(label)}</h5></div>
      <div class="d-flex flex-wrap align-items-center gap-2 ms-auto">
        <select class="form-select form-select-sm" id="agendaCourseFilter" style="width:auto"><option value="">Todos los cursos</option>${courses.map((c) => `<option value="${esc(c.id)}" ${c.id === agendaCourse ? 'selected' : ''}>${esc(c.nombre)} · ${esc(c.seccion)}</option>`).join('')}</select>
        <div class="seg">${modes.map(([k, ic, tx]) => `<button class="${agendaMode === k ? 'on' : ''}" data-agenda-mode="${k}"><i class="bi bi-${ic}"></i><span>${tx}</span></button>`).join('')}</div>
      </div></div>`;
  let body = '';
  if (agendaMode === 'mes') {
    const y = agendaRef.getFullYear(), m = agendaRef.getMonth();
    const start = mondayOf(new Date(y, m, 1));
    const cells = [];
    for (let i = 0; i < 42; i++) {
      const d = addDays(start, i);
      if (i >= 35 && d.getMonth() !== m) break;
      const k = dayKey(d);
      const ts = tasksOnDay(k, list);
      cells.push(`<div class="cal-cell ${d.getMonth() !== m ? 'out' : ''} ${k === todayK ? 'today' : ''} ${k === agendaDay ? 'sel' : ''}" data-agenda-day="${k}">
        <span class="cal-num">${d.getDate()}</span>${ts.slice(0, 3).map((t) => agendaChip(t, false)).join('')}${ts.length > 3 ? `<span class="cal-more">+${ts.length - 3} más</span>` : ''}</div>`);
    }
    const dayK = agendaDay || todayK;
    const dayTasks = tasksOnDay(dayK, list);
    body = `<div class="row g-3"><div class="col-xl-9"><div class="surface-card p-2 p-md-3"><div class="cal-grid">${DIAS.map((x) => `<div class="cal-dow">${x}</div>`).join('')}${cells.join('')}</div></div></div>
      <div class="col-xl-3"><div class="surface-card day-panel"><div class="small muted text-uppercase fw-bold ls">${dayK === todayK ? 'Hoy' : 'Día seleccionado'}</div><h6 class="fw-bold mb-3">${esc(longDay(fromKey(dayK)))}</h6>
        ${dayTasks.length ? dayTasks.map(agendaItem).join('') : '<p class="small muted mb-0">No hay entregas este día.</p>'}</div></div></div>`;
  } else if (agendaMode === 'semana') {
    const start = mondayOf(agendaRef);
    body = `<div class="week-grid">${DIAS.map((dn, i) => {
      const d = addDays(start, i); const k = dayKey(d);
      const ts = tasksOnDay(k, list);
      return `<div class="week-col ${k === todayK ? 'today' : ''}"><div class="week-head"><span>${dn}</span><strong>${d.getDate()}</strong></div>${ts.map((t) => agendaChip(t)).join('') || '<div class="week-empty">—</div>'}</div>`;
    }).join('')}</div>`;
  } else {
    const now = new Date();
    const late = isTeacher() ? [] : list.filter((t) => isExpired(t) && eventClass(t) === 'ev-late');
    const next = list.filter((t) => new Date(t.fecha_limite) >= addDays(now, -1) && !(isExpired(t) && dayKey(t.fecha_limite) !== todayK));
    const groupsByDay = new Map();
    for (const t of next) { const k = dayKey(t.fecha_limite); if (!groupsByDay.has(k)) groupsByDay.set(k, []); groupsByDay.get(k).push(t); }
    const rel = (k) => { const diff = Math.round((fromKey(k) - fromKey(todayK)) / 86400000); return diff === 0 ? 'Hoy' : diff === 1 ? 'Mañana' : `En ${diff} días`; };
    body = `${late.length ? `<div class="surface-card mb-3 border-late"><h6 class="fw-bold text-danger mb-2"><i class="bi bi-exclamation-triangle me-1"></i>Vencidas sin entregar (${late.length})</h6>${late.map(agendaItem).join('')}</div>` : ''}
      <div class="surface-card">${groupsByDay.size ? [...groupsByDay.entries()].map(([k, ts]) => `<div class="ag-day"><div class="ag-date"><strong>${fromKey(k).getDate()}</strong><span class="text-capitalize">${esc(new Intl.DateTimeFormat('es-GT', { month: 'short' }).format(fromKey(k)))}</span><small>${rel(k)}</small></div><div class="flex-grow-1 min-w-0">${ts.map(agendaItem).join('')}</div></div>`).join('') : empty('No hay actividades próximas.')}</div>`;
  }
  $('#mainContent').innerHTML = `<div class="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-3"><div><h4 class="section-heading mb-1">Agenda de tareas</h4><p class="muted mb-0">Fechas de entrega de todas tus actividades.</p></div>${isTeacher() ? '<button class="btn btn-primary" data-action="new-task"><i class="bi bi-plus-lg me-1"></i>Nueva tarea</button>' : ''}</div>
    ${toolbar}${body}<div class="mt-3">${legend}</div>`;
}

// ---------- Material de lectura ----------
const readingFilesOf = (id) => readingFiles.filter((f) => f.material_id === id);
function fileIcon(name = '') {
  const e = fileExt(name);
  return { pdf: 'file-earmark-pdf', doc: 'file-earmark-word', docx: 'file-earmark-word', ppt: 'file-earmark-slides', pptx: 'file-earmark-slides', xls: 'file-earmark-excel', xlsx: 'file-earmark-excel', png: 'file-earmark-image', jpg: 'file-earmark-image', jpeg: 'file-earmark-image', zip: 'file-earmark-zip', txt: 'file-earmark-text' }[e] || 'file-earmark';
}
async function renderMaterial() {
  setTitle('Material de lectura', 'Mi espacio');
  const teacher = isTeacher();
  if (!hasV7) { $('#mainContent').innerHTML = v7Missing(); return; }
  if (viewArg) { materialCourse = viewArg; viewArg = null; }
  if (materialCourse && !course(materialCourse)) materialCourse = '';
  const token = renderToken;
  const list = readings.filter((m) => !materialCourse || m.curso_id === materialCourse);
  const urls = await signedMap(list.flatMap((m) => readingFilesOf(m.id)));
  if (token !== renderToken) return;
  const cards = list.map((m) => {
    const fs = readingFilesOf(m.id);
    const link = safeHttpUrl(m.enlace);
    return `<div class="col-md-6 col-xxl-4"><div class="read-card h-100">
      <div class="d-flex align-items-start gap-3 mb-2"><div class="read-icon"><i class="bi bi-${fs.length ? fileIcon(fs[0].nombre_archivo) : link ? 'link-45deg' : 'book'}"></i></div>
        <div class="flex-grow-1 min-w-0"><h6 class="fw-bold mb-1">${esc(m.titulo)}</h6><div class="small muted">${esc(courseName(m.curso_id))} · ${esc(fmt(m.creado_en))}</div></div>
        ${teacher ? `<button class="btn btn-sm btn-link text-danger p-0" data-delete-reading="${esc(m.id)}" title="Eliminar material"><i class="bi bi-trash"></i></button>` : ''}</div>
      ${m.descripcion ? `<p class="small mb-3" style="white-space:pre-wrap">${esc(m.descripcion)}</p>` : ''}
      <div class="file-list">${fs.map((f) => { const u = urls.get(f.ruta_storage); return `<div class="file-chip"><i class="bi bi-${fileIcon(f.nombre_archivo)}"></i>${u ? `<a target="_blank" rel="noopener noreferrer" href="${esc(u)}">${esc(f.nombre_archivo)}</a>` : `<span>${esc(f.nombre_archivo)}</span>`}<span class="ms-auto small muted text-nowrap">${f.tamano_bytes ? `${Math.max(1, Math.round(f.tamano_bytes / 1024))} KB` : ''}</span></div>`; }).join('')}
        ${link ? `<div class="file-chip"><i class="bi bi-box-arrow-up-right"></i><a target="_blank" rel="noopener noreferrer" href="${esc(link)}">Abrir enlace</a></div>` : ''}</div>
    </div></div>`;
  }).join('');
  $('#mainContent').innerHTML = `<div class="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-4">
      <div><h4 class="section-heading mb-1">Biblioteca del curso</h4><p class="muted mb-0">${teacher ? 'Comparte lecturas, guías y archivos. No son tareas: no se entregan ni se califican.' : 'Lecturas y archivos que comparte tu docente. Solo para leer o descargar.'}</p></div>
      <div class="d-flex gap-2"><select class="form-select form-select-sm" id="materialCourseFilter" style="min-width:200px"><option value="">Todos los cursos</option>${courses.map((c) => `<option value="${esc(c.id)}" ${c.id === materialCourse ? 'selected' : ''}>${esc(c.nombre)} · ${esc(c.seccion)}</option>`).join('')}</select>
      ${teacher ? '<button class="btn btn-primary text-nowrap" data-action="new-material"><i class="bi bi-cloud-arrow-up me-1"></i>Subir material</button>' : ''}</div></div>
    ${list.length ? `<div class="row g-3">${cards}</div>` : empty(teacher ? 'Todavía no has compartido material. Usa "Subir material".' : 'Tu docente aún no ha compartido material de lectura.')}`;
}
function openMaterialModal(courseId = null) {
  if (!hasV7) return notify('Primero ejecuta migracion-v7-material-consultas.sql en Supabase.', 'warning');
  if (!courses.length) return notify('Primero crea un curso.', 'warning');
  $('#materialForm').reset();
  $('#materialCourse').innerHTML = courseOptions();
  if (courseId) $('#materialCourse').value = courseId;
  modal('#materialModal').show();
}
async function deleteReading(id) {
  const m = readings.find((x) => x.id === id);
  if (!m || !confirm(`¿Eliminar "${m.titulo}"?\nLas alumnas ya no podrán verlo.`)) return;
  const paths = readingFilesOf(id).map((f) => f.ruta_storage);
  const r = await db.from('materiales').delete().eq('id', id);
  if (r.error) return notify(errMsg(r.error), 'danger');
  if (paths.length) await db.storage.from(BUCKET).remove(paths);
  notify('Material eliminado.');
  await refresh(true);
}

// ---------- Consultas ----------
function queryRow(q) {
  const l = lastMsg(q);
  const t = q.tarea_id && task(q.tarea_id);
  const who = isTeacher() ? `${avatarHtml(q.usuarios)}` : '<div class="task-symbol"><i class="bi bi-chat-dots"></i></div>';
  return `<div class="task-row clickable q-row ${queryState(q) === (isTeacher() ? 'espera' : 'respondida') ? 'unread' : ''}" data-open-query="${esc(q.id)}">${who}
    <div class="flex-grow-1 min-w-0"><div class="d-flex flex-wrap align-items-center gap-2 mb-1"><h6 class="fw-bold mb-0">${esc(q.asunto)}</h6>${queryBadge(q)}</div>
      <div class="small muted text-truncate">${isTeacher() ? `${esc(fullName(q.usuarios))} · ` : ''}${esc(courseName(q.curso_id))}${t ? ` · <i class="bi bi-clipboard-check"></i> ${esc(t.titulo)}` : ''}</div>
      ${l ? `<div class="small text-truncate mt-1"><span class="muted">${l.autor_id === me.id ? 'Tú' : l.autor_id === q.alumna_id ? esc(q.usuarios?.nombre || 'Alumna') : 'Docente'}:</span> ${esc(l.mensaje)}</div>` : ''}</div>
    <div class="small muted text-nowrap">${esc(fmt(q.actualizado_en))}</div></div>`;
}
function renderQueries() {
  setTitle('Consultas', 'Mi espacio');
  if (!hasV7) { $('#mainContent').innerHTML = v7Missing(); return; }
  const teacher = isTeacher();
  const filters = { abiertas: (q) => !q.resuelta, resueltas: (q) => q.resuelta, todas: () => true };
  const list = queries.filter(filters[queriesTab] || filters.todas);
  const tabs = `<div class="seg mb-3">${[['abiertas', 'Abiertas'], ['resueltas', 'Resueltas'], ['todas', 'Todas']].map(([k, tx]) => `<button class="${queriesTab === k ? 'on' : ''}" data-queries-tab="${k}">${tx} <span class="opacity-75">(${queries.filter(filters[k]).length})</span></button>`).join('')}</div>`;
  $('#mainContent').innerHTML = `<div class="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-4">
      <div><h4 class="section-heading mb-1">${teacher ? 'Consultas de tus alumnas' : 'Mis consultas'}</h4><p class="muted mb-0">${teacher ? 'Preguntas privadas de tus alumnas. Solo las ven ella y tú.' : 'Pregúntale a tu docente lo que no entiendas. Solo tu docente puede verlas.'}</p></div>
      ${teacher ? '' : '<button class="btn btn-primary" data-action="new-query"><i class="bi bi-plus-lg me-1"></i>Nueva consulta</button>'}</div>
    ${tabs}<div class="surface-card">${list.length ? list.map(queryRow).join('') : empty(teacher ? 'No hay consultas en esta lista.' : 'No tienes consultas aquí. ¡Pregunta cuando tengas dudas!')}</div>`;
}
async function renderQueryDetail(id) {
  const q = queries.find((x) => x.id === id);
  if (!q) { navigate('consultas'); return; }
  const token = renderToken;
  setTitle(q.asunto, 'Consultas');
  await loadPhotos([q.usuarios]);
  if (token !== renderToken) return;
  const t = q.tarea_id && task(q.tarea_id);
  const bubbles = msgsOf(q.id).map((m) => {
    const mine = m.autor_id === me.id;
    const fromStudent = m.autor_id === q.alumna_id;
    const av = fromStudent ? avatarHtml(q.usuarios) : `<span class="avatar avatar-sm teacher-av"><i class="bi bi-person-workspace"></i></span>`;
    return `<div class="bubble-row ${mine ? 'mine' : ''}">${mine ? '' : av}<div class="bubble"><div class="bubble-who">${mine ? 'Tú' : fromStudent ? esc(fullName(q.usuarios)) : 'Docente'} · ${esc(fmt(m.creado_en))}</div><div style="white-space:pre-wrap">${esc(m.mensaje)}</div></div></div>`;
  }).join('');
  const canDelete = isTeacher() || msgsOf(q.id).every((m) => m.autor_id === q.alumna_id);
  $('#mainContent').innerHTML = `<button class="btn btn-link ps-0 mb-3" data-back="consultas"><i class="bi bi-arrow-left"></i> Volver a consultas</button>
    <div class="row g-4"><div class="col-lg-8"><div class="surface-card chat-card">
      <div class="d-flex flex-wrap justify-content-between align-items-start gap-2 mb-3 pb-3 border-bottom"><div><h5 class="fw-bold mb-1">${esc(q.asunto)}</h5><div class="small muted">${isTeacher() ? `${esc(fullName(q.usuarios))} · ` : ''}${esc(courseName(q.curso_id))}</div></div>${queryBadge(q)}</div>
      <div class="chat-thread">${bubbles || '<p class="muted small">Sin mensajes.</p>'}</div>
      <form id="queryReplyForm" class="chat-reply mt-3"><textarea class="form-control" name="mensaje" rows="2" maxlength="4000" required placeholder="${isTeacher() ? 'Escribe tu respuesta…' : 'Escribe otro mensaje…'}"></textarea><button class="btn btn-primary" type="submit" id="queryReplyBtn" title="Enviar"><i class="bi bi-send-fill"></i></button></form>
    </div></div>
    <div class="col-lg-4"><div class="surface-card mb-3"><h6 class="fw-bold mb-3">Detalles</h6>
      <div class="small mb-2"><i class="bi bi-collection me-2"></i>${esc(courseName(q.curso_id))}</div>
      ${t ? `<div class="small mb-2"><i class="bi bi-clipboard-check me-2"></i><button class="link-btn p-0" data-open-task="${esc(t.id)}">${esc(t.titulo)}</button></div>` : ''}
      <div class="small mb-3"><i class="bi bi-clock me-2"></i>Creada el ${esc(fmt(q.creado_en))}</div>
      <button class="btn btn-sm ${q.resuelta ? 'btn-outline-secondary' : 'btn-success'} w-100 mb-2" data-toggle-resolved="${esc(q.id)}"><i class="bi bi-${q.resuelta ? 'arrow-counterclockwise' : 'check2-circle'} me-1"></i>${q.resuelta ? 'Volver a abrir' : 'Marcar como resuelta'}</button>
      ${canDelete ? `<button class="btn btn-sm btn-outline-danger w-100" data-delete-query="${esc(q.id)}"><i class="bi bi-trash me-1"></i>Eliminar consulta</button>` : ''}
    </div></div></div>`;
  const th = $('.chat-thread'); if (th) th.scrollTop = th.scrollHeight;
}
function openQueryModal(taskId = null) {
  if (!hasV7) return notify('Primero ejecuta migracion-v7-material-consultas.sql en Supabase.', 'warning');
  if (!courses.length) return notify('Primero únete a una clase.', 'warning');
  const f = $('#queryForm');
  f.reset();
  $('#queryCourse').innerHTML = courseOptions();
  const t = taskId && task(taskId);
  if (t) $('#queryCourse').value = t.curso_id;
  fillQueryTasks(t?.id);
  if (t) f.elements.asunto.value = `Duda sobre: ${t.titulo}`.slice(0, 200);
  modal('#queryModal').show();
}
function fillQueryTasks(selected = '') {
  const cId = $('#queryCourse').value;
  $('#queryTask').innerHTML = `<option value="">— Pregunta general del curso —</option>${tasks.filter((t) => t.curso_id === cId).map((t) => `<option value="${esc(t.id)}" ${t.id === selected ? 'selected' : ''}>${esc(t.titulo)}</option>`).join('')}`;
}
async function toggleResolved(id) {
  const q = queries.find((x) => x.id === id);
  if (!q) return;
  const r = await db.from('consultas').update({ resuelta: !q.resuelta }).eq('id', id);
  if (r.error) return notify(errMsg(r.error), 'danger');
  notify(q.resuelta ? 'Consulta abierta de nuevo.' : 'Consulta marcada como resuelta.');
  await refresh(true);
}
async function deleteQuery(id) {
  if (!confirm('¿Eliminar esta consulta y todos sus mensajes?')) return;
  const r = await db.from('consultas').delete().eq('id', id);
  if (r.error) return notify(errMsg(r.error), 'danger');
  notify('Consulta eliminada.');
  view = 'consultas'; viewArg = null;
  await refresh(true);
}

// ---------- Clics de v7 ----------
function handleV7Click(el) {
  let b;
  if ((b = el('[data-go]'))) { navigate(b.dataset.go); return true; }
  if ((b = el('[data-mini-nav]'))) { miniRef = new Date(miniRef.getFullYear(), miniRef.getMonth() + Number(b.dataset.miniNav), 1); const host = b.closest('.side-card'); if (host) host.lastElementChild.outerHTML = miniCalendarHtml(); return true; }
  if ((b = el('[data-agenda-mode]'))) { agendaMode = b.dataset.agendaMode; renderAgenda(); return true; }
  if ((b = el('[data-agenda-nav]'))) {
    const n = Number(b.dataset.agendaNav);
    if (!n) { agendaRef = new Date(); agendaDay = dayKey(agendaRef); }
    else agendaRef = agendaMode === 'semana' ? addDays(agendaRef, 7 * n) : new Date(agendaRef.getFullYear(), agendaRef.getMonth() + n, 1);
    renderAgenda(); return true;
  }
  if (el('.ev-chip')) return false; // abre la tarea
  if ((b = el('[data-agenda-day]'))) {
    if (view === 'agenda') { agendaDay = b.dataset.agendaDay; renderAgenda(); } else { agendaMode = 'mes'; navigate('agenda', b.dataset.agendaDay); }
    return true;
  }
  if ((b = el('[data-open-material]'))) { navigate('material', b.dataset.openMaterial); return true; }
  if ((b = el('[data-delete-reading]'))) { deleteReading(b.dataset.deleteReading); return true; }
  if ((b = el('[data-queries-tab]'))) { queriesTab = b.dataset.queriesTab; renderQueries(); return true; }
  if (el('a')) return false;
  if ((b = el('[data-open-query]'))) { navigate('consulta', b.dataset.openQuery); return true; }
  if ((b = el('[data-ask-task]'))) { openQueryModal(b.dataset.askTask); return true; }
  if ((b = el('[data-toggle-resolved]'))) { toggleResolved(b.dataset.toggleResolved); return true; }
  if ((b = el('[data-delete-query]'))) { deleteQuery(b.dataset.deleteQuery); return true; }
  return false;
}

// Subir material
$('#materialForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const link = String(f.get('enlace') || '').trim();
  const list = [...$('#materialFiles').files];
  if (link && !safeHttpUrl(link)) return notify('El enlace debe empezar con https:// o http://.', 'warning');
  if (!link && !list.length && !String(f.get('descripcion') || '').trim()) return notify('Agrega un archivo, un enlace o una descripción.', 'warning');
  const bad = checkFiles(list);
  if (bad) return notify(bad, 'warning');
  await busy($('#materialSubmitBtn'), async () => {
    const r = await db.from('materiales').insert({
      curso_id: f.get('curso_id'), docente_id: me.id, titulo: f.get('titulo').trim(),
      descripcion: String(f.get('descripcion') || '').trim() || null, enlace: link || null,
    }).select().single();
    if (r.error) return notify(errMsg(r.error), 'danger');
    const failed = [];
    for (const file of list) {
      const path = `${READ_DIR}/${r.data.id}/${crypto.randomUUID()}-${safeName(file.name)}`;
      const up = await db.storage.from(BUCKET).upload(path, file, { upsert: false, contentType: mimeFor(file.name) });
      if (up.error) { failed.push(`${file.name}: ${up.error.message}`); continue; }
      const meta = await db.from('archivos_material').insert({ material_id: r.data.id, nombre_archivo: file.name, ruta_storage: path, tipo_archivo: mimeFor(file.name), tamano_bytes: file.size });
      if (meta.error) { failed.push(`${file.name}: ${meta.error.message}`); await db.storage.from(BUCKET).remove([path]); }
    }
    modal('#materialModal').hide();
    if (failed.length) notify(`El material se guardó, pero algunos archivos no: ${failed.join('; ')}`, 'warning', 9000);
    else notify('Material compartido con tus alumnas.');
    view = 'material'; viewArg = r.data.curso_id;
    await refresh();
  });
});

// Nueva consulta (alumna)
$('#queryCourse').addEventListener('change', () => fillQueryTasks());
$('#queryForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const mensaje = String(f.get('mensaje') || '').trim();
  if (!mensaje) return notify('Escribe tu pregunta.', 'warning');
  await busy($('#querySubmitBtn'), async () => {
    const r = await db.from('consultas').insert({ curso_id: f.get('curso_id'), alumna_id: me.id, tarea_id: f.get('tarea_id') || null, asunto: f.get('asunto').trim() }).select().single();
    if (r.error) return notify(errMsg(r.error), 'danger');
    const m = await db.from('consulta_mensajes').insert({ consulta_id: r.data.id, autor_id: me.id, mensaje });
    if (m.error) { await db.from('consultas').delete().eq('id', r.data.id); return notify(errMsg(m.error), 'danger'); }
    modal('#queryModal').hide();
    notify('Consulta enviada a tu docente.');
    view = 'consulta'; viewArg = r.data.id;
    await refresh();
  });
});

// Responder en una consulta
$('#mainContent').addEventListener('submit', async (e) => {
  if (e.target.id !== 'queryReplyForm') return;
  e.preventDefault();
  const mensaje = e.target.elements.mensaje.value.trim();
  if (!mensaje || view !== 'consulta') return;
  await busy($('#queryReplyBtn'), async () => {
    const r = await db.from('consulta_mensajes').insert({ consulta_id: viewArg, autor_id: me.id, mensaje });
    if (r.error) return notify(errMsg(r.error), 'danger');
    await refresh(true);
  });
});
$('#mainContent').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && e.target.closest('#queryReplyForm')) { e.preventDefault(); $('#queryReplyBtn').click(); }
});

// =====================================================================
// v8: RESPALDO EN EXCEL Y LIMPIEZA DE DATOS (docente)
// =====================================================================
const XLSX_URL = 'https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs';
let backupCourse = '';
const backedUp = new Set();          // cursos con Excel descargado en esta sesión
const CLEAN_OPTS = [
  ['entregas', 'Entregas, archivos de las alumnas y calificaciones', true],
  ['tareas', 'Tareas y su material de apoyo (incluye sus entregas)', false],
  ['consultas', 'Consultas y sus mensajes', true],
  ['material', 'Material de lectura y sus archivos', false],
  ['avisos', 'Avisos', true],
  ['grupos', 'Grupos', false],
  ['alumnas', 'Quitar a las alumnas del curso (sus cuentas NO se borran)', false],
];
const xDate = (s) => (s ? fmt(s) : '');
function sheetFrom(XLSX, rows, widths) {
  const ws = XLSX.utils.json_to_sheet(rows.length ? rows : [{ '(sin datos)': '' }], { cellDates: true });
  const keys = Object.keys(rows[0] || { '(sin datos)': '' });
  ws['!cols'] = keys.map((k, i) => ({ wch: widths?.[i] ?? Math.min(45, Math.max(10, k.length + 2)) }));
  for (const addr of Object.keys(ws)) if (ws[addr]?.t === 'd') ws[addr].z = 'dd/mm/yyyy hh:mm';
  return ws;
}
function backupRows(c) {
  const ts = tasks.filter((t) => t.curso_id === c.id).sort((a, b) => new Date(a.fecha_limite) - new Date(b.fecha_limite));
  const st = studentsOf(c.id);
  const notas = st.map((en) => {
    const u = en.usuarios || {};
    const row = { Clave: u.clave ?? '', Apellido: u.apellido || '', Nombre: u.nombre || '', Usuario: u.usuario || '', Grupo: groupOf(en.alumna_id, c.id)?.nombre || '' };
    for (const t of ts) {
      const s = submissionOf(t.id, en.alumna_id); const g = s && gradeFor(s.id);
      row[`${t.titulo} (/${t.puntos_maximos})`.slice(0, 80)] = g ? Number(g.nota) : hasWork(s) ? 'Sin calificar' : isExpired(t) && !isExpo(t) ? 'No entregó' : 'Pendiente';
    }
    const a = accumulated(en.alumna_id, c.id);
    return { ...row, 'Puntos obtenidos': Math.round(a.earned * 100) / 100, 'Puntos posibles': Math.round(a.possible * 100) / 100, 'Nota acumulada %': a.pct === null ? '' : Math.round(a.pct * 100) / 100 };
  });
  const entregas = submissions.filter((s) => ts.some((t) => t.id === s.tarea_id)).map((s) => {
    const t = task(s.tarea_id); const g = gradeFor(s.id);
    const u = st.find((e) => e.alumna_id === s.alumna_id)?.usuarios || s.usuarios || {};
    return { Clave: u.clave ?? '', Alumna: listName(u), Tarea: t.titulo, Tipo: TIPOS[t.tipo] || 'Tarea', 'Fecha límite': xDate(t.fecha_limite), 'Fecha de entrega': xDate(s.fecha_entrega), Tardía: isLate(s) ? 'Sí' : 'No',
      Nota: g ? Number(g.nota) : '', 'De': Number(t.puntos_maximos), 'Comentario docente': g?.comentario || '', Respuesta: s.contenido || '', Enlace: s.enlace || '', Archivos: filesFor(s.id).map((f) => f.nombre_archivo).join(', ') };
  }).sort((a, b) => String(a.Clave).localeCompare(String(b.Clave), 'es', { numeric: true }));
  const tareas = ts.map((t) => ({ Título: t.titulo, Tipo: TIPOS[t.tipo] || 'Tarea', Modalidad: t.modalidad === 'grupal' ? 'En grupo' : 'Individual', Puntos: Number(t.puntos_maximos), 'Fecha límite': xDate(t.fecha_limite), Publicada: xDate(t.fecha_publicacion), Descripción: t.descripcion || '', Instrucciones: t.instrucciones || '', 'Material de apoyo': materialsFor(t.id).map((m) => m.nombre_archivo).join(', ') }));
  const consultas = queries.filter((q) => q.curso_id === c.id).map((q) => ({ Alumna: fullName(q.usuarios), Asunto: q.asunto, Tarea: task(q.tarea_id)?.titulo || '', Estado: q.resuelta ? 'Resuelta' : 'Abierta', Creada: xDate(q.creado_en),
    Conversación: msgsOf(q.id).map((m) => `[${fmt(m.creado_en)}] ${m.autor_id === q.alumna_id ? 'Alumna' : 'Docente'}: ${m.mensaje}`).join('\n') }));
  const material = readings.filter((m) => m.curso_id === c.id).map((m) => ({ Título: m.titulo, Descripción: m.descripcion || '', Enlace: m.enlace || '', Archivos: readingFilesOf(m.id).map((f) => f.nombre_archivo).join(', '), Publicado: xDate(m.creado_en) }));
  const avisos = notices.filter((n) => n.curso_id === c.id).map((n) => ({ Título: n.titulo, Mensaje: n.contenido, Publicado: xDate(n.creado_en) }));
  return { notas, entregas, tareas, consultas, material, avisos };
}
async function downloadBackup(btn) {
  const c = course(backupCourse);
  if (!c) return;
  await busy(btn, async () => {
    let XLSX;
    try { XLSX = await import(XLSX_URL); } catch (err) { console.error(err); return notify('No se pudo cargar la herramienta de Excel. Revisa tu conexión a internet.', 'danger'); }
    const d = backupRows(c);
    const wb = XLSX.utils.book_new();
    wb.Props = { Title: `Respaldo ${c.nombre}`, Author: fullName(me), Company: 'Villa de las Niñas' };
    XLSX.utils.book_append_sheet(wb, sheetFrom(XLSX, d.notas, [7, 18, 18, 16, 12]), 'Notas');
    XLSX.utils.book_append_sheet(wb, sheetFrom(XLSX, d.entregas, [7, 28, 30, 13, 17, 17, 8, 7, 5, 35, 40, 30, 35]), 'Entregas');
    XLSX.utils.book_append_sheet(wb, sheetFrom(XLSX, d.tareas, [32, 13, 11, 8, 17, 17, 45, 45, 30]), 'Tareas');
    if (hasV7) {
      XLSX.utils.book_append_sheet(wb, sheetFrom(XLSX, d.consultas, [28, 32, 28, 10, 17, 80]), 'Consultas');
      XLSX.utils.book_append_sheet(wb, sheetFrom(XLSX, d.material, [32, 45, 35, 35, 17]), 'Material');
    }
    XLSX.utils.book_append_sheet(wb, sheetFrom(XLSX, d.avisos, [32, 70, 17]), 'Avisos');
    const name = `Respaldo_${c.nombre}_${c.grado}_${c.seccion}_${dayKey(new Date())}`.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9_-]+/g, '_');
    XLSX.writeFile(wb, `${name}.xlsx`, { compression: true });
    backedUp.add(c.id);
    notify('Excel descargado. Guárdalo en un lugar seguro antes de borrar.', 'success', 7000);
    renderBackup();
  });
}
function renderBackup() {
  setTitle('Respaldo y limpieza', 'Mi espacio');
  if (!isTeacher()) { navigate('inicio'); return; }
  if (!courses.length) { $('#mainContent').innerHTML = empty('Primero crea un curso.'); return; }
  if (!course(backupCourse)) backupCourse = courses[0].id;
  const c = course(backupCourse);
  const ts = tasks.filter((t) => t.curso_id === c.id);
  const count = {
    entregas: submissions.filter((s) => ts.some((t) => t.id === s.tarea_id)).length,
    tareas: ts.length, consultas: queries.filter((q) => q.curso_id === c.id).length, material: readings.filter((m) => m.curso_id === c.id).length,
    avisos: notices.filter((n) => n.curso_id === c.id).length, grupos: groupsOf(c.id).length, alumnas: studentsOf(c.id).length,
  };
  const done = backedUp.has(c.id);
  const select = `<select class="form-select" id="backupCourseSelect" style="width:auto;min-width:240px">${courses.map((x) => `<option value="${esc(x.id)}" ${x.id === c.id ? 'selected' : ''}>${esc(x.nombre)} · ${esc(x.grado)} ${esc(x.seccion)}</option>`).join('')}</select>`;
  $('#mainContent').innerHTML = `<div class="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-4">
      <div><h4 class="section-heading mb-1">Respaldo y limpieza de datos</h4><p class="muted mb-0">Al terminar el ciclo, descarga todo en Excel y después libera espacio en la base de datos.</p></div>${select}</div>
    <div class="row g-4">
      <div class="col-lg-6"><div class="surface-card h-100 step-card">
        <div class="step-num">1</div><h5 class="fw-bold mb-1">Descargar respaldo en Excel</h5>
        <p class="small muted">Un archivo .xlsx con hojas de <strong>Notas</strong> (una columna por tarea y la nota acumulada), <strong>Entregas</strong>, <strong>Tareas</strong>, <strong>Consultas</strong>, <strong>Material</strong> y <strong>Avisos</strong>. Los archivos que subieron las alumnas no se incluyen, solo sus nombres.</p>
        <div class="d-flex flex-wrap gap-2 small mb-3">${[['people', count.alumnas, 'alumnas'], ['clipboard-check', count.tareas, 'tareas'], ['inbox', count.entregas, 'entregas'], ['chat-dots', count.consultas, 'consultas']].map(([i, n, l]) => `<span class="count-chip"><i class="bi bi-${i}"></i>${n} ${l}</span>`).join('')}</div>
        <button class="btn btn-primary" data-download-backup><i class="bi bi-file-earmark-excel me-1"></i>Descargar Excel de ${esc(c.nombre)}</button>
        ${done ? '<div class="small text-success mt-3"><i class="bi bi-check-circle-fill me-1"></i>Ya descargaste el respaldo de este curso.</div>' : ''}
      </div></div>
      <div class="col-lg-6"><div class="surface-card h-100 step-card danger ${done ? '' : 'locked'}">
        <div class="step-num">2</div><h5 class="fw-bold mb-1">Borrar datos del curso</h5>
        <p class="small muted">Elige qué borrar. <strong>No se puede deshacer.</strong> El curso y las cuentas de las alumnas se conservan.</p>
        ${done ? '' : '<div class="alert alert-warning small py-2"><i class="bi bi-lock me-1"></i>Primero descarga el Excel de este curso (paso 1).</div>'}
        <form id="cleanForm">${CLEAN_OPTS.map(([k, label, on]) => `<label class="clean-opt"><input class="form-check-input" type="checkbox" name="${k}" ${on ? 'checked' : ''} ${done ? '' : 'disabled'}><span>${esc(label)}</span><span class="ms-auto badge-soft pill-blue">${count[k]}</span></label>`).join('')}
          <label class="form-label small mt-3">Para confirmar escribe <strong>BORRAR</strong></label>
          <div class="d-flex gap-2"><input class="form-control" name="confirm" autocomplete="off" placeholder="BORRAR" ${done ? '' : 'disabled'}><button class="btn btn-danger text-nowrap" type="submit" id="cleanBtn" ${done ? '' : 'disabled'}><i class="bi bi-trash me-1"></i>Borrar</button></div>
        </form>
      </div></div>
    </div>`;
}
async function removeInChunks(paths) {
  let failed = 0;
  for (let i = 0; i < paths.length; i += 100) {
    const r = await db.storage.from(BUCKET).remove(paths.slice(i, i + 100));
    if (r.error) { failed += Math.min(100, paths.length - i); console.warn(r.error.message); }
  }
  return failed;
}
async function cleanCourse(form) {
  const c = course(backupCourse);
  if (!c || !backedUp.has(c.id)) return notify('Primero descarga el Excel de este curso.', 'warning');
  const o = Object.fromEntries(CLEAN_OPTS.map(([k]) => [k, form.elements[k].checked]));
  if (!Object.values(o).some(Boolean)) return notify('Elige al menos una opción.', 'warning');
  if (form.elements.confirm.value.trim().toUpperCase() !== 'BORRAR') return notify('Escribe BORRAR para confirmar.', 'warning');
  const chosen = CLEAN_OPTS.filter(([k]) => o[k]).map(([, l]) => `• ${l}`).join('\n');
  if (!confirm(`Vas a borrar de "${c.nombre} ${c.seccion}":\n\n${chosen}\n\nEsto no se puede deshacer. ¿Continuar?`)) return;
  await busy($('#cleanBtn'), async () => {
    const ts = tasks.filter((t) => t.curso_id === c.id);
    // Primero los archivos del Storage (las filas de la base aún existen para validar permisos)
    const paths = [];
    if (o.entregas || o.tareas) paths.push(...submissions.filter((s) => ts.some((t) => t.id === s.tarea_id)).flatMap((s) => filesFor(s.id).map((f) => f.ruta_storage)));
    if (o.tareas) paths.push(...ts.flatMap((t) => materialsFor(t.id).map((m) => m.ruta_storage)));
    if (o.material) paths.push(...readings.filter((m) => m.curso_id === c.id).flatMap((m) => readingFilesOf(m.id).map((f) => f.ruta_storage)));
    const failed = await removeInChunks(paths);
    const r = await db.rpc('vaciar_curso', { p_curso: c.id, p_entregas: o.entregas, p_tareas: o.tareas, p_consultas: o.consultas, p_material: o.material, p_avisos: o.avisos, p_grupos: o.grupos, p_alumnas: o.alumnas });
    if (r.error) {
      const msg = /vaciar_curso|function/i.test(r.error.message) ? 'Falta ejecutar migracion-v8-respaldo-limpieza.sql en Supabase.' : errMsg(r.error);
      return notify(msg, 'danger', 9000);
    }
    const res = r.data || {};
    const summary = Object.entries(res).map(([k, n]) => `${n} ${k}`).join(', ') || 'nada';
    notify(`Datos borrados: ${summary}.${failed ? ` ${failed} archivo(s) no se pudieron quitar del almacenamiento.` : ''}`, failed ? 'warning' : 'success', 9000);
    await refresh(true);
  });
}
$('#mainContent').addEventListener('click', (e) => { const b = e.target.closest('[data-download-backup]'); if (b) downloadBackup(b); });
$('#mainContent').addEventListener('change', (e) => { if (e.target.id === 'backupCourseSelect') { backupCourse = e.target.value; renderBackup(); } });
$('#mainContent').addEventListener('submit', (e) => { if (e.target.id === 'cleanForm') { e.preventDefault(); cleanCourse(e.target); } });

// =====================================================================
// v9: BUSCAR INFORMACIÓN (Wikipedia dentro de la plataforma + Google seguro)
// =====================================================================
const WIKI = 'https://es.wikipedia.org';
let searchTab = 'enciclopedia', searchQuery = '', wikiResults = null, wikiArticle = null, wikiBusy = false;
let cseReady = null;
let histCourse = '', histStudent = '', histRows = null, histErr = null, histWarned = false;
// Guarda la búsqueda de la alumna (la docente la ve en "Historial de alumnas")
function logSearch(q, tipo) {
  if (isTeacher() || !q) return;
  db.from('busquedas').insert({ alumna_id: me.id, consulta: String(q).slice(0, 300), tipo }).then(({ error }) => {
    if (error && !histWarned) { histWarned = true; console.warn('Historial no disponible (¿falta migracion-v9?):', error.message); }
  });
}

function renderSearch() {
  setTitle('Buscar información', 'Mi espacio');
  const tabs = [['enciclopedia', 'book-half', 'Enciclopedia'], ['web', 'globe2', 'Web (búsqueda segura)'], ...(isTeacher() ? [['historial', 'clock-history', 'Historial de alumnas']] : [])];
  if (searchTab === 'historial' && !isTeacher()) searchTab = 'enciclopedia';
  $('#mainContent').innerHTML = `<div class="search-hero mb-4">
      <div class="small search-kicker"><i class="bi bi-search me-1"></i>INVESTIGA SIN SALIR DEL AULA</div>
      <h3 class="fw-bold mb-3">¿Qué quieres aprender hoy?</h3>
      <form id="searchForm" class="search-box"><i class="bi bi-search"></i><input name="q" id="searchInput" autocomplete="off" maxlength="200" placeholder="Ej. fotosíntesis, Revolución de 1944, qué es una base de datos…" value="${esc(searchQuery)}"><button class="btn btn-primary" type="submit">Buscar</button></form>
      ${isTeacher() ? '' : '<div class="small mt-2 opacity-75"><i class="bi bi-eye me-1"></i>Tus búsquedas se guardan y tu docente puede verlas.</div>'}
      <div class="seg mt-3 seg-dark">${tabs.map(([k, ic, tx]) => `<button type="button" class="${searchTab === k ? 'on' : ''}" data-search-tab="${k}"><i class="bi bi-${ic}"></i><span>${tx}</span></button>`).join('')}</div>
    </div><div id="searchResults"></div>`;
  paintSearchResults();
}
function paintSearchResults() {
  const box = $('#searchResults');
  if (!box) return;
  if (searchTab === 'web') return paintWeb(box);
  if (searchTab === 'historial') return paintHistory(box);
  if (wikiArticle) return paintArticle(box);
  if (wikiBusy) { box.innerHTML = '<div class="py-5 text-center"><div class="spinner-border text-primary"></div></div>'; return; }
  if (!wikiResults) {
    box.innerHTML = `<div class="row g-3">${[['lightbulb', 'Escribe palabras clave', 'Mejor "volcanes de Guatemala" que una pregunta muy larga.'], ['journal-text', 'Lee aquí mismo', 'Los artículos de la enciclopedia se abren dentro de la plataforma.'], ['quote', 'Cita tus fuentes', 'Cada artículo tiene un botón para copiar la cita de la fuente.']].map(([i, t, d]) => `<div class="col-md-4"><div class="surface-card h-100 d-flex gap-3"><div class="task-symbol"><i class="bi bi-${i}"></i></div><div><div class="fw-bold">${t}</div><div class="small muted">${d}</div></div></div></div>`).join('')}</div>`;
    return;
  }
  if (!wikiResults.length) { box.innerHTML = empty(`No se encontraron artículos para "${searchQuery}". Prueba con otras palabras o busca en la pestaña Web.`); return; }
  box.innerHTML = `<p class="small muted mb-2">${wikiResults.length} resultados en la enciclopedia para <strong>${esc(searchQuery)}</strong></p>
    <div class="surface-card">${wikiResults.map((r) => `<div class="wiki-row clickable" data-wiki="${esc(r.title)}">
      ${r.thumb ? `<img class="wiki-thumb" src="${esc(r.thumb)}" alt="" loading="lazy">` : '<div class="wiki-thumb ph"><i class="bi bi-journal-text"></i></div>'}
      <div class="flex-grow-1 min-w-0"><h6 class="fw-bold mb-1">${esc(r.title)}</h6><p class="small text-muted mb-0">${esc(r.extract || '')}</p></div>
      <i class="bi bi-chevron-right muted"></i></div>`).join('')}</div>`;
}
async function wikiSearch(q) {
  wikiArticle = null; wikiBusy = true; paintSearchResults();
  logSearch(q, 'enciclopedia');
  try {
    const url = `${WIKI}/w/api.php?action=query&format=json&origin=*&generator=search&gsrsearch=${encodeURIComponent(q)}&gsrlimit=12&prop=pageimages|extracts&exintro=1&explaintext=1&exsentences=2&exlimit=max&piprop=thumbnail&pithumbsize=160`;
    const j = await (await fetch(url)).json();
    wikiResults = Object.values(j.query?.pages || {}).sort((a, b) => a.index - b.index)
      .map((p) => ({ title: p.title, extract: p.extract, thumb: safeWikiImg(p.thumbnail?.source) }));
  } catch (err) {
    console.error(err); wikiResults = null; notify('No se pudo conectar con la enciclopedia. Revisa tu conexión.', 'danger');
  } finally { wikiBusy = false; paintSearchResults(); }
}
function safeWikiImg(src) {
  if (!src) return null;
  const s = src.startsWith('//') ? `https:${src}` : src;
  return /^https:\/\/upload\.wikimedia\.org\//.test(s) ? s : null;
}
// Limpia el HTML del artículo: sin scripts, estilos ni atributos peligrosos
function cleanWikiHtml(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script,style,link,meta,iframe,object,embed,form,input,button,noscript,audio,video,source,sup.reference,.mw-ref,.mw-references-wrap,.reflist,ol.references,.navbox,.metadata,.mw-editsection,.ambox,.noprint,.mw-empty-elt,.hatnote').forEach((n) => n.remove());
  // Quita secciones finales de referencias / enlaces externos
  doc.querySelectorAll('section').forEach((sec) => { const h = sec.querySelector('h2'); if (h && /referencias|notas|enlaces externos|bibliografía|véase también/i.test(h.textContent)) sec.remove(); });
  const keep = { a: ['href'], img: ['src', 'alt', 'width', 'height'], td: ['colspan', 'rowspan'], th: ['colspan', 'rowspan'] };
  for (const el of doc.body.querySelectorAll('*')) {
    const tag = el.tagName.toLowerCase();
    for (const at of [...el.attributes]) if (!(keep[tag] || []).includes(at.name)) el.removeAttribute(at.name);
    if (tag === 'a') {
      const h = el.getAttribute('href') || '';
      if (h.startsWith('./') && !h.includes(':')) { el.setAttribute('data-wiki', decodeURIComponent(h.slice(2).split('#')[0]).replace(/_/g, ' ')); el.setAttribute('href', '#'); }
      else if (/^https?:\/\//.test(h)) { el.setAttribute('target', '_blank'); el.setAttribute('rel', 'noopener noreferrer'); }
      else el.removeAttribute('href');
    }
    if (tag === 'img') { const s = safeWikiImg(el.getAttribute('src')); if (s) { el.setAttribute('src', s); el.setAttribute('loading', 'lazy'); } else el.remove(); }
    if (tag === 'table') el.classList.add('table', 'table-sm');
  }
  return doc.body.innerHTML;
}
async function wikiOpen(title) {
  wikiBusy = true; wikiArticle = null; searchTab = 'enciclopedia'; paintSearchResults();
  window.scrollTo(0, 0);
  try {
    const res = await fetch(`${WIKI}/api/rest_v1/page/html/${encodeURIComponent(title.replace(/ /g, '_'))}?redirect=true`);
    if (!res.ok) throw new Error(res.status);
    const html = await res.text();
    const t = new DOMParser().parseFromString(html, 'text/html').querySelector('title')?.textContent || title;
    logSearch(t, 'articulo');
    wikiArticle = { title: t, body: cleanWikiHtml(html), url: `${WIKI}/wiki/${encodeURIComponent(t.replace(/ /g, '_'))}` };
  } catch (err) {
    console.error(err); notify('No se pudo abrir el artículo.', 'danger');
  } finally { wikiBusy = false; paintSearchResults(); }
}
function citation(a) {
  const d = new Intl.DateTimeFormat('es-GT', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date());
  return `${a.title}. (s.f.). En Wikipedia, la enciclopedia libre. Recuperado el ${d} de ${a.url}`;
}
function paintArticle(box) {
  const a = wikiArticle;
  box.innerHTML = `<div class="d-flex flex-wrap align-items-center gap-2 mb-3">
      <button class="btn btn-link ps-0" data-wiki-back><i class="bi bi-arrow-left"></i> ${wikiResults ? 'Volver a los resultados' : 'Volver'}</button>
      <div class="ms-auto d-flex gap-2"><button class="btn btn-sm btn-outline-primary" data-copy-cite><i class="bi bi-quote me-1"></i>Copiar cita</button>
      <a class="btn btn-sm btn-light" target="_blank" rel="noopener noreferrer" href="${esc(a.url)}"><i class="bi bi-box-arrow-up-right me-1"></i>Ver en Wikipedia</a></div></div>
    <article class="surface-card wiki-article"><div class="wiki-source"><i class="bi bi-book-half me-1"></i>Enciclopedia · Wikipedia en español</div><h2 class="fw-bold mb-3">${esc(a.title)}</h2>${a.body}
      <div class="cite-box mt-4"><div class="small fw-bold mb-1"><i class="bi bi-quote me-1"></i>Cómo citar esta fuente</div><div class="small">${esc(citation(a))}</div></div></article>`;
}

// ---- Web: Google Programmable Search con búsqueda segura ----
function loadCse() {
  if (cseReady) return cseReady;
  cseReady = new Promise((resolve, reject) => {
    window.__gcse = { parsetags: 'explicit', initializationCallback: resolve };
    const s = document.createElement('script');
    s.async = true; s.src = `https://cse.google.com/cse.js?cx=${encodeURIComponent(CSE_ID)}`;
    s.onerror = () => { cseReady = null; reject(new Error('cse')); };
    document.head.append(s);
  });
  return cseReady;
}
async function paintWeb(box) {
  if (!CSE_ID) {
    const g = `https://www.google.com/search?safe=active&q=${encodeURIComponent(searchQuery)}`;
    box.innerHTML = `<div class="surface-card"><div class="d-flex gap-3"><div class="task-symbol"><i class="bi bi-globe2"></i></div><div>
      <h6 class="fw-bold mb-1">La búsqueda web todavía no está activada</h6>
      <p class="small muted mb-3">${isTeacher() ? 'Para ver resultados de internet aquí mismo hay que agregar el código del buscador seguro de Google en <code>js/config.js</code> (está explicado en el README).' : 'Tu docente aún no la ha activado. Mientras tanto usa la Enciclopedia o abre Google con búsqueda segura.'}</p>
      ${searchQuery ? `<a class="btn btn-sm btn-primary" target="_blank" rel="noopener noreferrer" href="${esc(g)}"><i class="bi bi-box-arrow-up-right me-1"></i>Buscar "${esc(searchQuery)}" en Google (búsqueda segura)</a>` : ''}</div></div></div>`;
    return;
  }
  box.innerHTML = `<div class="surface-card web-results"><div class="small muted mb-2"><i class="bi bi-shield-check me-1"></i>Búsqueda segura activada. Los sitios se abren en una pestaña nueva.</div><div id="cseHost"></div></div>`;
  try {
    await loadCse();
    const host = $('#cseHost');
    if (!host) return;
    google.search.cse.element.render({ div: 'cseHost', tag: 'searchresults-only', gname: 'aulaWeb', attributes: { safeSearch: 'active', linkTarget: '_blank', enableHistory: false } });
    if (searchQuery) google.search.cse.element.getElement('aulaWeb').execute(searchQuery);
  } catch (err) {
    console.error(err);
    box.innerHTML = `<div class="alert alert-warning">No se pudo cargar el buscador web. Revisa tu conexión o el código del buscador en <code>js/config.js</code>.</div>`;
  }
}

// ---- Historial de búsquedas (docente) ----
const TIPO_BUSQ = { enciclopedia: ['Enciclopedia', 'pill-purple'], web: ['Web', 'pill-blue'], articulo: ['Leyó artículo', 'pill-green'] };
async function loadHistory() {
  const c = course(histCourse);
  histRows = null; histErr = null;
  const ids = c ? studentsOf(c.id).map((e) => e.alumna_id) : [];
  if (!ids.length) { histRows = []; return; }
  const r = await inChunks(ids, (p) => db.from('busquedas').select('*').in('alumna_id', p).order('creado_en', { ascending: false }).limit(1000), byDate('creado_en', true));
  if (r.data) r.data = r.data.slice(0, 1000);
  if (r.error) histErr = /busquedas|relation|schema/i.test(r.error.message) ? 'Falta ejecutar migracion-v9-historial-busquedas.sql en Supabase.' : errMsg(r.error);
  else histRows = r.data || [];
}
async function paintHistory(box, reload = true) {
  if (!courses.length) { box.innerHTML = empty('Primero crea un curso.'); return; }
  if (!course(histCourse)) histCourse = courses[0].id;
  const c = course(histCourse);
  if (reload) {
    box.innerHTML = '<div class="py-5 text-center"><div class="spinner-border text-primary"></div></div>';
    const token = renderToken;
    await loadHistory();
    if (token !== renderToken || searchTab !== 'historial') return;
  }
  const st = studentsOf(c.id);
  const userOf = (id) => st.find((e) => e.alumna_id === id)?.usuarios;
  const head = `<div class="surface-card mb-3 d-flex flex-wrap align-items-center gap-2">
      <select class="form-select form-select-sm" id="histCourseSelect" style="width:auto;min-width:220px">${courses.map((x) => `<option value="${esc(x.id)}" ${x.id === c.id ? 'selected' : ''}>${esc(x.nombre)} · ${esc(x.grado)} ${esc(x.seccion)}</option>`).join('')}</select>
      <select class="form-select form-select-sm" id="histStudentSelect" style="width:auto;min-width:200px"><option value="">Todas las alumnas</option>${st.map((e) => `<option value="${esc(e.alumna_id)}" ${e.alumna_id === histStudent ? 'selected' : ''}>${esc(e.usuarios?.clave ?? '')} ${esc(listName(e.usuarios))}</option>`).join('')}</select>
      <div class="input-icon flex-grow-1" style="max-width:300px"><i class="bi bi-funnel"></i><input class="form-control form-control-sm" id="histFilter" placeholder="Filtrar por palabra"></div>
      <button class="btn btn-sm btn-outline-danger ms-auto" data-clear-history ${histRows?.length ? '' : 'disabled'}><i class="bi bi-trash me-1"></i>Borrar historial del curso</button></div>`;
  if (histErr) { box.innerHTML = head + `<div class="alert alert-warning">${esc(histErr)}</div>`; return; }
  const rows = (histRows || []).filter((r) => !histStudent || r.alumna_id === histStudent);
  const freq = new Map();
  for (const r of rows) if (r.tipo !== 'articulo') { const k = r.consulta.trim().toLowerCase(); freq.set(k, (freq.get(k) || 0) + 1); }
  const top = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  const plain = (v) => String(v ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  box.innerHTML = head + `<div class="row g-3 mb-3">
      <div class="col-sm-4"><div class="stat-card h-100"><div class="stat-icon pill-purple"><i class="bi bi-search"></i></div><h3>${rows.filter((r) => r.tipo !== 'articulo').length}</h3><div class="stat-label">Búsquedas</div></div></div>
      <div class="col-sm-4"><div class="stat-card h-100"><div class="stat-icon pill-green"><i class="bi bi-journal-text"></i></div><h3>${rows.filter((r) => r.tipo === 'articulo').length}</h3><div class="stat-label">Artículos leídos</div></div></div>
      <div class="col-sm-4"><div class="stat-card h-100"><div class="stat-icon pill-blue"><i class="bi bi-people"></i></div><h3>${new Set(rows.map((r) => r.alumna_id)).size}/${st.length}</h3><div class="stat-label">Alumnas que buscaron</div></div></div></div>
    ${top.length ? `<div class="surface-card mb-3"><h6 class="fw-bold mb-2">Lo más buscado</h6><div class="d-flex flex-wrap gap-2">${top.map(([k, n]) => `<span class="count-chip">${esc(k)} <strong>${n}</strong></span>`).join('')}</div></div>` : ''}
    <div class="surface-card">${rows.length ? `<div class="table-responsive"><table class="table table-hover align-middle mb-0"><thead><tr><th>Fecha</th><th class="text-center">Clave</th><th>Alumna</th><th>Tipo</th><th>Búsqueda</th></tr></thead><tbody>${rows.map((r) => {
        const u = userOf(r.alumna_id); const [tl, tc] = TIPO_BUSQ[r.tipo] || ['Búsqueda', 'pill-blue'];
        return `<tr data-search="${esc(plain(`${r.consulta} ${listName(u)}`))}"><td class="small text-nowrap">${esc(fmt(r.creado_en))}</td><td class="text-center clave-cell">${esc(u?.clave ?? '—')}</td><td class="fw-semibold">${esc(listName(u))}</td><td>${badge(tl, tc)}</td><td>${esc(r.consulta)}</td></tr>`;
      }).join('')}</tbody></table></div>${histRows?.length >= 1000 ? '<p class="small muted mt-2 mb-0">Se muestran las 1000 búsquedas más recientes.</p>' : ''}` : empty('Las alumnas de este curso aún no han buscado nada.')}</div>`;
}
async function clearHistory(btn) {
  const c = course(histCourse);
  const ids = c ? studentsOf(c.id).map((e) => e.alumna_id) : [];
  if (!ids.length || !confirm(`¿Borrar todo el historial de búsquedas de las alumnas de ${c.nombre} ${c.seccion}?\nNo se puede deshacer.`)) return;
  await busy(btn, async () => {
    const r = await inChunks(ids, (p) => db.from('busquedas').delete().in('alumna_id', p));
    if (r.error) return notify(errMsg(r.error), 'danger');
    notify('Historial borrado.');
    await paintHistory($('#searchResults'));
  });
}
$('#mainContent').addEventListener('change', (e) => {
  if (e.target.id === 'histCourseSelect') { histCourse = e.target.value; histStudent = ''; paintHistory($('#searchResults')); }
  if (e.target.id === 'histStudentSelect') { histStudent = e.target.value; paintHistory($('#searchResults'), false); }
});
$('#mainContent').addEventListener('input', (e) => {
  if (e.target.id !== 'histFilter') return;
  const q = e.target.value.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  document.querySelectorAll('#searchResults tr[data-search]').forEach((tr) => tr.classList.toggle('d-none', q && !tr.dataset.search.includes(q)));
});

$('#mainContent').addEventListener('submit', (e) => {
  if (e.target.id !== 'searchForm') return;
  e.preventDefault();
  const q = e.target.elements.q.value.trim();
  if (q.length < 2) return notify('Escribe al menos 2 letras.', 'warning');
  searchQuery = q;
  if (searchTab === 'historial') searchTab = 'enciclopedia';
  if (searchTab === 'web') { logSearch(q, 'web'); renderSearch(); } else { if (!$('[data-search-tab].on[data-search-tab="enciclopedia"]')) renderSearch(); wikiSearch(q); }
});
$('#mainContent').addEventListener('click', (e) => {
  if (view !== 'buscar') return;
  let b;
  if ((b = e.target.closest('[data-search-tab]'))) {
    searchTab = b.dataset.searchTab;
    document.querySelectorAll('[data-search-tab]').forEach((x) => x.classList.toggle('on', x === b));
    if (searchTab === 'enciclopedia' && searchQuery && !wikiResults && !wikiArticle) wikiSearch(searchQuery); else paintSearchResults();
    return;
  }
  if ((b = e.target.closest('[data-wiki]'))) { e.preventDefault(); wikiOpen(b.dataset.wiki); return; }
  if (e.target.closest('[data-wiki-back]')) { wikiArticle = null; paintSearchResults(); return; }
  if ((b = e.target.closest('[data-clear-history]'))) { clearHistory(b); return; }
  if (e.target.closest('[data-copy-cite]') && wikiArticle) {
    const c = citation(wikiArticle);
    navigator.clipboard?.writeText(c).then(() => notify('Cita copiada. Pégala en tu tarea.'), () => notify(c, 'info', 12000));
  }
});


// =====================================================================
// v10: ESPACIO COMPARTIDO POR CURSO (tipo chat)
// Las alumnas solo lo ven si la docente lo abrió. La docente siempre lo ve.
// =====================================================================
const SHARE_BUCKET = 'compartidos';
const hasV10 = (c) => !!c && 'compartir_abierto' in c;
let shareCourse = null, shareMsgs = [], shareErr = null, shareTimer = null;
const shareNames = new Map(), shareSigned = new Map();
const shareCourses = () => (isTeacher() ? courses : courses.filter((c) => c.compartir_abierto));
const fmtSize = (n) => (!n ? '' : n < 1048576 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1048576).toFixed(1)} MB`);

async function loadShared(c) {
  shareErr = null;
  const r = await db.from('compartidos').select('*').eq('curso_id', c.id).order('creado_en', { ascending: false }).limit(300);
  if (r.error) {
    shareErr = /compartidos|relation|schema|column/i.test(r.error.message) ? 'Falta ejecutar migracion-v10-espacio-compartido.sql en Supabase.' : errMsg(r.error);
    shareMsgs = [];
    return;
  }
  shareMsgs = (r.data || []).sort(byDate('creado_en'));
  // Nombres de quienes escribieron (las alumnas ven a sus compañeras de curso)
  for (const e of enrollments.filter((x) => x.curso_id === c.id)) if (e.usuarios) shareNames.set(e.alumna_id, e.usuarios);
  shareNames.set(me.id, me);
  const missing = [...new Set(shareMsgs.map((m) => m.autor_id))].filter((id) => id !== c.docente_id && !shareNames.has(id));
  if (missing.length) {
    const u = await inChunks(missing, (p) => db.from('usuarios').select('id,nombre,apellido,clave').in('id', p));
    for (const x of u.data || []) shareNames.set(x.id, x);
  }
  const paths = shareMsgs.map((m) => m.ruta_storage).filter((p) => p && !shareSigned.has(p));
  if (paths.length) {
    const { data } = await db.storage.from(SHARE_BUCKET).createSignedUrls(paths, 3600);
    for (const d of data || []) if (d.signedUrl) shareSigned.set(d.path, d.signedUrl);
  }
}

async function renderShared() {
  setTitle('Espacio compartido');
  const teacher = isTeacher();
  if (!courses.length) { $('#mainContent').innerHTML = empty(teacher ? 'Primero crea un curso.' : 'Primero únete a una clase.'); return; }
  if (teacher && !courses.some(hasV10)) {
    $('#mainContent').innerHTML = '<div class="alert alert-warning">Para usar el espacio compartido ejecuta <strong>migracion-v10-espacio-compartido.sql</strong> en Supabase.</div>';
    return;
  }
  const list = shareCourses();
  if (!list.length) {
    $('#mainContent').innerHTML = `<div class="surface-card text-center py-5"><i class="bi bi-lock fs-1 muted"></i><h5 class="fw-bold mt-3">El espacio compartido está cerrado</h5><p class="muted mb-0">Tu docente todavía no ha abierto un espacio para compartir documentos en tus cursos.</p></div>`;
    return;
  }
  if (!list.some((c) => c.id === shareCourse)) shareCourse = list[0].id;
  const c = course(shareCourse);
  const token = renderToken;
  loading();
  await loadShared(c);
  if (token !== renderToken) return;

  const select = `<select class="form-select form-select-sm" id="shareCourseSelect" style="width:auto;min-width:240px">${list.map((x) => `<option value="${esc(x.id)}" ${x.id === c.id ? 'selected' : ''}>${esc(x.nombre)} · ${esc(x.grado)} ${esc(x.seccion)}${teacher ? (x.compartir_abierto ? ' · abierto' : ' · cerrado') : ''}</option>`).join('')}</select>`;
  const control = teacher ? `<div class="surface-card mb-3 d-flex flex-wrap align-items-center gap-3">
      <div class="form-check form-switch mb-0"><input class="form-check-input" type="checkbox" role="switch" id="shareOpen" ${c.compartir_abierto ? 'checked' : ''}>
      <label class="form-check-label fw-semibold" for="shareOpen">Espacio abierto para las alumnas de este curso</label></div>
      <span class="small ${c.compartir_abierto ? 'text-success' : 'muted'}"><i class="bi bi-${c.compartir_abierto ? 'unlock' : 'lock'} me-1"></i>${c.compartir_abierto ? 'Abierto: las alumnas ven, comparten y escriben.' : 'Cerrado: las alumnas no ven nada. Solo tú ves lo que ya se compartió.'}</span></div>` : '';
  $('#mainContent').innerHTML = `<div class="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-3">
      <div><h4 class="section-heading mb-1">Espacio compartido</h4><p class="muted mb-0">${teacher ? 'Lo que comparten tus alumnas en cada curso. Puedes escribir y borrar mensajes.' : 'Comparte documentos y enlaces con tus compañeras. Tu docente ve todo lo que se comparte.'}</p></div>${select}</div>
    ${control}${shareErr ? `<div class="alert alert-warning">${esc(shareErr)}</div>` : ''}
    <div class="row g-4"><div class="col-lg-8"><div class="surface-card chat-card">
      <div class="chat-thread share-thread" id="shareThread"></div>
      <form id="shareForm" class="chat-reply share-reply mt-3">
        <div class="flex-grow-1">
          <textarea class="form-control mb-2" name="texto" rows="2" maxlength="4000" placeholder="Escribe un mensaje… (Ctrl+Enter para enviar)"></textarea>
          <div class="d-flex flex-wrap align-items-center gap-2">
            <label class="btn btn-sm btn-outline-secondary mb-0"><i class="bi bi-paperclip me-1"></i>Adjuntar<input type="file" id="shareFile" class="d-none" accept=".pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.accdb,.mdb,.png,.jpg,.jpeg,.txt,.zip"></label>
            <span class="small muted text-truncate" id="shareFileName" style="max-width:220px"></span>
            <input type="url" name="enlace" class="form-control form-control-sm" placeholder="Enlace (opcional) https://…" style="max-width:280px">
          </div>
        </div>
        <button class="btn btn-primary" type="submit" id="shareSendBtn" title="Enviar"><i class="bi bi-send-fill"></i></button>
      </form>
    </div></div>
    <div class="col-lg-4"><div class="surface-card"><h6 class="fw-bold mb-3"><i class="bi bi-folder2-open me-1"></i>Documentos compartidos</h6><div id="shareDocs"></div></div></div></div>`;
  paintShareThread(c, true);
  startSharePoll();
}

function paintShareThread(c, toBottom = false) {
  const th = $('#shareThread');
  if (!th) return;
  const nearBottom = th.scrollHeight - th.scrollTop - th.clientHeight < 80;
  const teacher = isTeacher();
  th.innerHTML = shareMsgs.map((m) => {
    const mine = m.autor_id === me.id;
    const isDoc = m.autor_id === c.docente_id;
    const u = shareNames.get(m.autor_id);
    const who = mine ? 'Tú' : isDoc ? 'Docente' : u ? fullName(u) : 'Compañera';
    const av = isDoc ? '<span class="avatar avatar-sm teacher-av"><i class="bi bi-person-workspace"></i></span>' : avatarHtml(u);
    const url = m.ruta_storage && shareSigned.get(m.ruta_storage);
    const file = m.ruta_storage ? (url
      ? `<a class="share-file" target="_blank" rel="noopener noreferrer" href="${esc(url)}"><i class="bi bi-file-earmark-arrow-down"></i> ${esc(m.nombre_archivo)} <span class="opacity-75">${esc(fmtSize(m.tamano_bytes))}</span></a>`
      : `<span class="share-file"><i class="bi bi-file-earmark"></i> ${esc(m.nombre_archivo)}</span>`) : '';
    const link = safeHttpUrl(m.enlace) ? `<a class="share-file" target="_blank" rel="noopener noreferrer" href="${esc(safeHttpUrl(m.enlace))}"><i class="bi bi-link-45deg"></i> ${esc(new URL(m.enlace).hostname)}</a>` : '';
    const del = teacher || (mine && c.compartir_abierto) ? `<button class="share-del" data-del-share="${esc(m.id)}" title="Borrar mensaje"><i class="bi bi-trash"></i></button>` : '';
    return `<div class="bubble-row ${mine ? 'mine' : ''}">${mine ? '' : av}<div class="bubble"><div class="bubble-who d-flex justify-content-between gap-3"><span>${esc(who)} · ${esc(fmt(m.creado_en))}</span>${del}</div>${m.texto ? `<div style="white-space:pre-wrap">${esc(m.texto)}</div>` : ''}${file}${link}</div></div>`;
  }).join('') || `<div class="text-center muted py-5"><i class="bi bi-chat-square-text fs-2"></i><p class="mt-2 mb-0">Todavía no hay nada compartido en este curso.${teacher ? '' : ' ¡Sé la primera!'}</p></div>`;
  if (toBottom || nearBottom) th.scrollTop = th.scrollHeight;
  const docs = shareMsgs.filter((m) => m.ruta_storage || safeHttpUrl(m.enlace)).reverse();
  $('#shareDocs').innerHTML = docs.length ? docs.map((m) => {
    const url = m.ruta_storage ? shareSigned.get(m.ruta_storage) : safeHttpUrl(m.enlace);
    const name = m.ruta_storage ? m.nombre_archivo : new URL(m.enlace).hostname;
    const u = shareNames.get(m.autor_id);
    const who = m.autor_id === me.id ? 'Tú' : m.autor_id === c.docente_id ? 'Docente' : u ? fullName(u) : 'Compañera';
    return `<div class="share-doc"><i class="bi bi-${m.ruta_storage ? 'file-earmark-text' : 'link-45deg'}"></i><div class="min-w-0"><a class="d-block text-truncate fw-semibold" target="_blank" rel="noopener noreferrer" href="${esc(url || '#')}">${esc(name)}</a><div class="small muted text-truncate">${esc(who)} · ${esc(fmt(m.creado_en))}</div></div></div>`;
  }).join('') : '<p class="small muted mb-0">Aún no se han compartido documentos ni enlaces.</p>';
}

// Revisa si hay mensajes nuevos cada 15 segundos mientras el chat está abierto
function startSharePoll() {
  clearInterval(shareTimer);
  shareTimer = setInterval(async () => {
    if (view !== 'compartido' || !$('#shareThread')) { clearInterval(shareTimer); return; }
    if (document.hidden) return;
    const c = course(shareCourse);
    if (!c) return;
    const before = shareMsgs.map((m) => m.id).join();
    await loadShared(c);
    if (shareMsgs.map((m) => m.id).join() !== before) paintShareThread(c);
  }, 15000);
}

$('#mainContent').addEventListener('change', async (e) => {
  if (e.target.id === 'shareCourseSelect') { shareCourse = e.target.value; renderShared(); }
  if (e.target.id === 'shareFile') { const f = e.target.files[0]; $('#shareFileName').textContent = f ? `${f.name} (${fmtSize(f.size)})` : ''; }
  if (e.target.id === 'shareOpen') {
    const c = course(shareCourse);
    const open = e.target.checked;
    if (open && !confirm(`¿Abrir el espacio compartido de ${c.nombre} ${c.seccion}?\n\nLas alumnas del curso podrán ver lo que se comparte, subir documentos y escribir. Tú verás todo.`)) { e.target.checked = false; return; }
    const r = await db.from('cursos').update({ compartir_abierto: open }).eq('id', c.id);
    if (r.error) { e.target.checked = !open; return notify(errMsg(r.error), 'danger'); }
    c.compartir_abierto = open;
    notify(open ? 'Espacio abierto para las alumnas.' : 'Espacio cerrado. Las alumnas ya no ven nada.');
    renderShared();
  }
});
$('#mainContent').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && e.target.closest('#shareForm')) { e.preventDefault(); $('#shareSendBtn').click(); }
});
$('#mainContent').addEventListener('submit', async (e) => {
  if (e.target.id !== 'shareForm') return;
  e.preventDefault();
  const c = course(shareCourse);
  const f = e.target;
  const texto = f.elements.texto.value.trim();
  const enlace = f.elements.enlace.value.trim();
  const file = $('#shareFile').files[0];
  if (!texto && !enlace && !file) return notify('Escribe un mensaje, adjunta un archivo o pega un enlace.', 'warning');
  if (enlace && !safeHttpUrl(enlace)) return notify('El enlace debe empezar con https:// o http://.', 'warning');
  if (file) { const bad = checkFiles([file]); if (bad) return notify(bad, 'warning'); }
  await busy($('#shareSendBtn'), async () => {
    let meta = {};
    if (file) {
      const path = `${c.id}/${me.id}/${crypto.randomUUID()}-${safeName(file.name)}`;
      const up = await db.storage.from(SHARE_BUCKET).upload(path, file, { upsert: false, contentType: mimeFor(file.name) });
      if (up.error) return notify(`No se pudo subir el archivo: ${up.error.message}`, 'danger');
      meta = { nombre_archivo: file.name, ruta_storage: path, tipo_archivo: mimeFor(file.name), tamano_bytes: file.size };
    }
    const r = await db.from('compartidos').insert({ curso_id: c.id, autor_id: me.id, texto: texto || null, enlace: enlace || null, ...meta });
    if (r.error) {
      if (meta.ruta_storage) await db.storage.from(SHARE_BUCKET).remove([meta.ruta_storage]);
      return notify(/row-level|policy/i.test(r.error.message) ? 'El espacio compartido de este curso está cerrado.' : errMsg(r.error), 'danger');
    }
    f.reset(); $('#shareFileName').textContent = '';
    await loadShared(c);
    paintShareThread(c, true);
  });
});
$('#mainContent').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-del-share]');
  if (!b) return;
  const m = shareMsgs.find((x) => x.id === b.dataset.delShare);
  if (!m || !confirm('¿Borrar este mensaje' + (m.ruta_storage ? ' y su archivo' : '') + '?')) return;
  const r = await db.from('compartidos').delete().eq('id', m.id);
  if (r.error) return notify(errMsg(r.error), 'danger');
  if (m.ruta_storage) await db.storage.from(SHARE_BUCKET).remove([m.ruta_storage]);
  const c = course(shareCourse);
  await loadShared(c);
  paintShareThread(c);
  notify('Mensaje borrado.');
});



// =====================================================================
// DESCARGAR TAREAS EN ZIP: Curso / clave - alumna / tarea / archivos
// =====================================================================
let jszipLoading = null;
function loadJSZip() {
  if (window.JSZip) return Promise.resolve(window.JSZip);
  return (jszipLoading ||= new Promise((ok, fail) => {
    const sc = document.createElement('script');
    sc.src = 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js';
    sc.onload = () => ok(window.JSZip);
    sc.onerror = () => { jszipLoading = null; fail(new Error('No se pudo cargar el compresor ZIP. Revisa tu conexión.')); };
    document.head.append(sc);
  }));
}
// Nombres válidos para carpetas y archivos en Windows
const cleanName = (v) => String(v ?? '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').replace(/[. ]+$/, '').trim().slice(0, 80) || 'sin nombre';
const studentFolder = (u) => cleanName(`${u?.clave ? String(u.clave).padStart(2, '0') + ' - ' : ''}${listName(u)}`);

function ensureDownloadModal() {
  if ($('#downloadModal')) return;
  document.body.insertAdjacentHTML('beforeend', `<div class="modal fade" id="downloadModal" tabindex="-1"><div class="modal-dialog modal-dialog-centered"><div class="modal-content">
    <div class="modal-header"><h5 class="modal-title"><i class="bi bi-file-earmark-zip me-1"></i>Descargar tareas</h5><button type="button" class="btn-close" data-bs-dismiss="modal"></button></div>
    <div class="modal-body">
      <label class="form-label">Curso</label><select class="form-select mb-3" id="dlCourse"></select>
      <label class="form-label">Tareas</label><select class="form-select mb-3" id="dlTask"></select>
      <div class="form-check mb-3"><input class="form-check-input" type="checkbox" id="dlNotes" checked><label class="form-check-label" for="dlNotes">Incluir respuestas escritas, enlaces, notas y un resumen de notas (Excel)</label></div>
      <div class="dl-tree small mb-3"><i class="bi bi-folder2"></i> <span id="dlRoot"></span><br>&nbsp;&nbsp;└ <i class="bi bi-folder2"></i> 01 - Apellido, Nombre<br>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ <i class="bi bi-folder2"></i> Nombre de la tarea<br>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ <i class="bi bi-file-earmark"></i> archivos de la alumna</div>
      <div class="alert alert-info small mb-0" id="dlInfo"></div>
      <div class="progress mt-3 d-none" id="dlProgressWrap" style="height:10px"><div class="progress-bar" id="dlProgress" style="width:0%"></div></div>
      <div class="small muted mt-2" id="dlStatus"></div>
    </div>
    <div class="modal-footer"><button type="button" class="btn btn-light" data-bs-dismiss="modal">Cerrar</button><button class="btn btn-primary" id="dlStart"><i class="bi bi-download me-1"></i>Descargar ZIP</button></div>
  </div></div></div>`);
  $('#dlCourse').addEventListener('change', () => { fillDownloadTasks(); updateDownloadInfo(); });
  $('#dlTask').addEventListener('change', updateDownloadInfo);
  $('#dlStart').addEventListener('click', startDownload);
}
function openDownloadModal() {
  if (!courses.length) return notify('Primero crea un curso.', 'warning');
  ensureDownloadModal();
  $('#dlCourse').innerHTML = courses.map((c) => `<option value="${esc(c.id)}" ${c.id === dashCourse ? 'selected' : ''}>${esc(c.nombre)} · ${esc(c.grado)} ${esc(c.seccion)}</option>`).join('');
  fillDownloadTasks();
  updateDownloadInfo();
  $('#dlProgressWrap').classList.add('d-none'); $('#dlStatus').textContent = '';
  modal('#downloadModal').show();
}
function fillDownloadTasks() {
  const ts = tasks.filter((t) => t.curso_id === $('#dlCourse').value);
  $('#dlTask').innerHTML = `<option value="">Todas las tareas (${ts.length})</option>${ts.map((t) => `<option value="${esc(t.id)}">${esc(t.titulo)}</option>`).join('')}`;
}
function downloadSelection() {
  const c = course($('#dlCourse').value);
  const ts = tasks.filter((t) => t.curso_id === c.id && (!$('#dlTask').value || t.id === $('#dlTask').value));
  const st = studentsOf(c.id);
  const items = [];
  for (const en of st) for (const t of ts) {
    const x = submissionOf(t.id, en.alumna_id);
    if (x) for (const f of filesFor(x.id)) items.push({ en, t, x, f });
  }
  return { c, ts, st, items };
}
function updateDownloadInfo() {
  const { c, ts, st, items } = downloadSelection();
  const bytes = items.reduce((n, i) => n + (Number(i.f.tamano_bytes) || 0), 0);
  const withWork = new Set(items.map((i) => i.en.alumna_id)).size;
  $('#dlRoot').textContent = cleanName(`${c.nombre} ${c.grado} ${c.seccion}`);
  $('#dlInfo').innerHTML = `${st.length} alumnas · ${ts.length} tarea(s) · <strong>${items.length} archivos</strong> (${fmtSize(bytes) || '0 KB'}) de ${withWork} alumnas.${items.length > 150 || bytes > 150 * 1048576 ? '<br>Son bastantes archivos: la descarga puede tardar unos minutos. No cierres la página.' : ''}`;
  $('#dlStart').disabled = !st.length || !ts.length;
}

async function startDownload() {
  const btn = $('#dlStart');
  const notes = $('#dlNotes').checked;
  const { c, ts, st, items } = downloadSelection();
  const bar = $('#dlProgress'), status = $('#dlStatus');
  btn.disabled = true;
  $('#dlProgressWrap').classList.remove('d-none');
  try {
    status.textContent = 'Preparando…';
    const JSZip = await loadJSZip();
    const zip = new JSZip();
    const rootName = cleanName(`${c.nombre} ${c.grado} ${c.seccion}`);
    const root = zip.folder(rootName);
    const used = new Set();
    const uniquePath = (p) => { let q = p, n = 2; while (used.has(q.toLowerCase())) { q = p.replace(/(\.[^./]+)?$/, ` (${n++})$1`); } used.add(q.toLowerCase()); return q; };

    // Carpetas por alumna, con su respuesta escrita y nota de cada tarea
    for (const en of st) {
      const folder = studentFolder(en.usuarios);
      let any = false;
      for (const t of ts) {
        const x = submissionOf(t.id, en.alumna_id);
        const g = x && gradeFor(x.id);
        if (!x || (!hasWork(x) && !g)) continue;
        any = true;
        if (notes && (x.contenido || x.enlace || g)) {
          const lines = [`Tarea: ${t.titulo}`, `Alumna: ${fullName(en.usuarios)}${en.usuarios?.clave ? ` (clave ${en.usuarios.clave})` : ''}`];
          if (hasWork(x)) lines.push(`Entregada: ${fmt(x.fecha_entrega)}${isLate(x) ? ' (TARDÍA)' : ''}`);
          if (x.contenido) lines.push('', 'Respuesta:', x.contenido);
          if (x.enlace) lines.push('', `Enlace: ${x.enlace}`);
          lines.push('', g ? `Nota: ${g.nota} de ${t.puntos_maximos}` : `Nota: sin calificar (de ${t.puntos_maximos})`);
          if (g?.comentario) lines.push(`Comentario: ${g.comentario}`);
          root.file(uniquePath(`${folder}/${cleanName(t.titulo)}/respuesta.txt`), lines.join('\r\n'));
        }
      }
      if (!any) root.file(uniquePath(`${folder}/SIN ENTREGAS.txt`), `${fullName(en.usuarios)} no tiene entregas en ${ts.length === 1 ? `"${ts[0].titulo}"` : 'estas tareas'}.`);
    }

    // Resumen de notas (se abre en Excel)
    if (notes) {
      const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const head = ['Clave', 'Alumna', 'Usuario', ...ts.map((t) => `${t.titulo} (/${t.puntos_maximos})`), 'Nota acumulada %'];
      const rows = st.map((en) => [en.usuarios?.clave ?? '', listName(en.usuarios), en.usuarios?.usuario ?? '',
        ...ts.map((t) => { const x = submissionOf(t.id, en.alumna_id); const g = x && gradeFor(x.id); return g ? String(g.nota).replace('.', ',') : hasWork(x) ? 'Entregó (sin nota)' : isExpired(t) ? 'No entregó' : 'Pendiente'; }),
        (() => { const a = accumulated(en.alumna_id, c.id); return a.pct === null ? '' : String(Math.round(a.pct)); })()]);
      root.file('Resumen de notas.csv', '﻿' + [head, ...rows].map((r) => r.map(q).join(';')).join('\r\n'));
    }

    // Descargar los archivos (4 a la vez)
    const failed = [];
    let done = 0;
    const queue = [...items];
    const worker = async () => {
      while (queue.length) {
        const it = queue.shift();
        const { data, error } = await db.storage.from(BUCKET).download(it.f.ruta_storage);
        if (error || !data) failed.push(`${listName(it.en.usuarios)} · ${it.t.titulo} · ${it.f.nombre_archivo}`);
        else root.file(uniquePath(`${studentFolder(it.en.usuarios)}/${cleanName(it.t.titulo)}/${cleanName(it.f.nombre_archivo)}`), data);
        done++;
        bar.style.width = `${Math.round((done / Math.max(1, items.length)) * 85)}%`;
        status.textContent = `Descargando archivos: ${done} de ${items.length}…`;
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));
    if (failed.length) root.file('ARCHIVOS QUE NO SE PUDIERON DESCARGAR.txt', failed.join('\r\n'));

    status.textContent = 'Armando el ZIP…';
    const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' }, (m) => { bar.style.width = `${85 + Math.round(m.percent * 0.15)}%`; });
    const taskPart = ts.length === 1 ? ` - ${cleanName(ts[0].titulo)}` : '';
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `${rootName}${taskPart} - tareas.zip` });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    bar.style.width = '100%';
    status.textContent = failed.length ? `Listo, pero ${failed.length} archivo(s) no se pudieron descargar (están anotados dentro del ZIP).` : `¡Listo! Se descargaron ${items.length} archivos.`;
    notify('ZIP descargado.');
  } catch (err) {
    console.error(err);
    status.textContent = '';
    notify(`No se pudo crear el ZIP: ${err.message}`, 'danger', 9000);
  } finally {
    btn.disabled = false;
  }
}
$('#mainContent').addEventListener('click', (e) => { if (e.target.closest('[data-open-download]')) openDownloadModal(); });


restore();

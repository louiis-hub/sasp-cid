var WORKER_BASE = 'https://sasp-intranet-bot.louisleurin.workers.dev';
var CID_STORE_KEY = 'sasp_cid_cases_v2';
var EFFECTIVE_CID_ROLE_ID = window.CID_ROLE_ID || '1518631634524569641';

var STATE = {
  user: null,
  roles: [],
  route: { page: 'dashboard' },
  q: '',
  filter: 'Toutes'
};

var STATUSES = ['Ouvert', 'En attente', 'Ferme', 'Classe'];
var PRIORITIES = ['Faible', 'Normale', 'Haute', 'Critique'];
var CLASSIFICATIONS = ['Homicide', 'Tentative', 'Braquage', 'Criminalite organisee', 'Corruption', 'Terrorisme', 'Enlevement', 'Stupefiants', 'Fraude', 'Cybercriminalite', 'Violences', 'Cambriolage', 'Autre'];
var CONFIDENTIALITIES = ['CID uniquement', 'Command Staff', 'SASP'];
var PERSON_TYPES = ['Citoyen', 'Suspect', 'Victime', 'Temoin', 'Informateur', 'Agent infiltre', 'Enqueteur'];
var EVIDENCE_TYPES = ['Photo', 'Document', 'ADN', 'Douille', 'Empreinte', 'Arme', 'Drogue', 'Vehicule', 'Objet', 'Telephone', 'Temoignage', 'Autre'];

function $(id) { return document.getElementById(id); }
function esc(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, function(c) {
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
  });
}
function nowLabel() {
  var d = new Date();
  return d.toISOString().slice(0, 16).replace('T', ' ');
}
function uid(prefix) { return prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7); }
function options(list, selected) {
  return list.map(function(v) { return '<option value="' + esc(v) + '"' + (v === selected ? ' selected' : '') + '>' + esc(v) + '</option>'; }).join('');
}

function getDb() {
  return supabase.createClient(SUPABASE_URL, SUPABASE_ANON);
}

async function finishOAuthRedirect() {
  var params = new URLSearchParams(window.location.search || '');
  var err = params.get('error_description') || params.get('error');
  if (err) throw new Error(err);
  if (!params.get('code')) return null;
  var db = getDb();
  var clean = window.location.origin + window.location.pathname;
  for (var i = 0; i < 12; i++) {
    var current = await db.auth.getSession();
    if (current.data && current.data.session) {
      window.history.replaceState({}, document.title, clean);
      return current.data.session;
    }
    await new Promise(function(resolve) { setTimeout(resolve, 400); });
  }
  window.history.replaceState({}, document.title, clean);
  return null;
}

async function loginDiscord() {
  var err = $('loginErr');
  if (err) err.classList.remove('show');
  var db = getDb();
  var res = await db.auth.signInWithOAuth({
    provider: 'discord',
    options: {
      scopes: 'identify email',
      redirectTo: 'https://louiis-hub.github.io/sasp-cid/'
    }
  });
  if (res.error && err) {
    err.textContent = res.error.message || 'Erreur de connexion Discord.';
    err.classList.add('show');
  }
}

async function logout() {
  await getDb().auth.signOut();
  STATE.user = null;
  STATE.roles = [];
  renderLogin();
}

function workerUrl(path, params) {
  var q = new URLSearchParams(params || {});
  if (typeof SITE_KEY !== 'undefined') q.set('site', SITE_KEY);
  return WORKER_BASE + path + (q.toString() ? '?' + q.toString() : '');
}

async function loadDiscordRoles(user) {
  var identity = user && user.identities && user.identities.find(function(i) { return i.provider === 'discord'; });
  var discordId = identity && identity.identity_data && (identity.identity_data.provider_id || identity.identity_data.sub);
  if (!discordId) return [];
  var res = await fetch(workerUrl('/auth/check-roles', { user_id: discordId }));
  if (!res.ok) return [];
  var data = await res.json();
  return data.roles || [];
}

function hasAccess() {
  if (STATE.roles.some(function(r) { return ROLE_ADMIN_IDS.indexOf(r) !== -1; })) return true;
  return STATE.roles.indexOf(EFFECTIVE_CID_ROLE_ID) !== -1;
}

async function boot() {
  try {
    var redirect = await finishOAuthRedirect();
    var session = redirect || (await getDb().auth.getSession()).data.session;
    if (!session) return renderLogin();
    STATE.user = session.user;
    STATE.roles = await loadDiscordRoles(session.user);
    if (!hasAccess()) return renderLogin('Acces refuse: role CID requis.');
    renderApp();
  } catch (e) {
    renderLogin('Erreur retour Discord: ' + (e.message || e));
  }
}

function renderLogin(message) {
  $('app').innerHTML = [
    '<main class="login-screen">',
      '<section class="login-card">',
        '<img class="login-logo" src="assets/logo.webp" alt="SASP">',
        '<div class="kicker">San Andreas State Police</div>',
        '<h1>SASP CID</h1>',
        '<p>Acces reserve aux enqueteurs CID et administrateurs.</p>',
        '<div id="loginErr" class="auth-error' + (message ? ' show' : '') + '">' + esc(message || '') + '</div>',
        '<button class="btn btn-blue" onclick="loginDiscord()">Se connecter avec Discord</button>',
        '<div class="kicker" style="margin-top:28px;color:#49698e">Criminal Investigation Division</div>',
      '</section>',
    '</main>'
  ].join('');
}

function casesLoad() {
  try { return JSON.parse(localStorage.getItem(CID_STORE_KEY) || '[]'); }
  catch(e) { return []; }
}
function casesSave(list) { localStorage.setItem(CID_STORE_KEY, JSON.stringify(list)); }
function caseGet(id) { return casesLoad().find(function(c) { return c.id === id; }); }
function caseUpsert(data) {
  var list = casesLoad();
  var i = list.findIndex(function(c) { return c.id === data.id; });
  data.updated_at = nowLabel();
  if (i >= 0) list[i] = data;
  else list.unshift(data);
  casesSave(list);
}
function nextNumber(list) {
  var year = new Date().getFullYear();
  var max = list.reduce(function(m, c) {
    var match = String(c.numero || '').match(/CID-\d{4}-(\d+)/);
    return match ? Math.max(m, parseInt(match[1], 10)) : m;
  }, 0);
  return 'CID-' + year + '-' + String(max + 1).padStart(4, '0');
}

function renderApp() {
  var userName = STATE.user && STATE.user.user_metadata && (STATE.user.user_metadata.full_name || STATE.user.user_metadata.name) || 'CID';
  $('app').innerHTML = [
    '<div class="app-shell">',
      '<aside class="sidebar">',
        '<div class="brand"><img src="assets/logo.webp" alt="SASP"><div><strong>SASP CID</strong><span>MDT enquete</span></div></div>',
        '<nav class="nav">',
          '<div class="nav-title">Menu principal</div>',
          navButton('dashboard', 'Tableau de bord'),
          navButton('dossiers', 'Dossiers'),
          navButton('personnes', 'Personnes'),
          navButton('preuves', 'Preuves'),
          navButton('archives', 'Archives'),
        '</nav>',
        '<div class="sidebar-foot"><strong>' + esc(userName) + '</strong><br>Connecte Discord</div>',
      '</aside>',
      '<main class="main">',
        '<header class="topbar">',
          '<input id="globalSearch" class="searchbox" placeholder="Rechercher un dossier, une personne, une preuve..." value="' + esc(STATE.q) + '">',
          '<span class="pill">Acces CID <i class="dot"></i></span>',
          '<button class="btn btn-ghost btn-small" onclick="logout()">Deconnexion</button>',
        '</header>',
        '<section id="content" class="content"></section>',
      '</main>',
    '</div>',
    '<div id="modalRoot" class="modal-backdrop"></div>'
  ].join('');
  $('globalSearch').addEventListener('input', function() {
    STATE.q = this.value;
    renderContent();
  });
  renderContent();
}

function navButton(page, label) {
  return '<button class="' + (STATE.route.page === page ? 'active' : '') + '" onclick="go(\'' + page + '\')">' + esc(label) + '</button>';
}
function go(page, extra) {
  STATE.route = Object.assign({ page: page }, extra || {});
  renderApp();
}

function allFiltered(includeArchived) {
  var q = STATE.q.toLowerCase();
  return casesLoad().filter(function(c) {
    if (!includeArchived && /classe|ferme/i.test(c.statut || '')) return false;
    if (STATE.filter !== 'Toutes' && c.statut !== STATE.filter) return false;
    var people = (c.personnes || []).map(function(p) { return [p.nom, p.tel, p.type].join(' '); }).join(' ');
    var proofs = (c.preuves || []).map(function(e) { return [e.scelle, e.type, e.description, proofDetailsText(c, e)].join(' '); }).join(' ');
    return [c.numero, c.titre, c.statut, c.priorite, c.classification, c.resume, people, proofs].join(' ').toLowerCase().indexOf(q) !== -1;
  }).sort(function(a, b) { return String(b.updated_at || '').localeCompare(String(a.updated_at || '')); });
}

function renderContent() {
  if (STATE.route.page === 'dashboard') return renderDashboard();
  if (STATE.route.page === 'personnes') return renderPeopleIndex();
  if (STATE.route.page === 'preuves') return renderEvidenceIndex();
  if (STATE.route.page === 'archives') return renderDossiers(true);
  renderDossiers(false);
}

function renderDashboard() {
  var list = casesLoad();
  var open = list.filter(function(c) { return c.statut === 'Ouvert'; }).length;
  var wait = list.filter(function(c) { return c.statut === 'En attente'; }).length;
  var critical = list.filter(function(c) { return c.priorite === 'Critique'; }).length;
  var proofs = list.reduce(function(n, c) { return n + (c.preuves || []).length; }, 0);
  $('content').innerHTML = [
    '<section class="dashboard-grid">',
      stat(open, 'Dossiers ouverts'),
      stat(wait, 'En attente'),
      stat(critical, 'Priorite critique'),
      stat(proofs, 'Preuves scellees'),
    '</section>',
    '<section class="panel section">',
      '<div class="panel-head" style="padding:0 0 14px;border-bottom:0"><div><div class="kicker">CID MDT</div><h1 style="margin:8px 0 0">Poste de commandement enquete</h1></div><button class="btn btn-gold" onclick="openCaseModal()">Nouveau dossier</button></div>',
      '<p class="text">Interface separee pour les dossiers CID : suspects, victimes, enqueteurs, preuves, photos, videos, notes et archives.</p>',
    '</section>',
    '<section class="panel section compact-panel">',
      '<div class="panel-head flush-head"><div class="panel-title">Derniers dossiers</div><button class="btn btn-ghost btn-small" onclick="go(' + js('dossiers') + ')">Ouvrir les dossiers</button></div>',
      recentCasesPanel(list),
    '</section>'
    ].join('');
}
function stat(n, label) { return '<div class="stat-card"><strong>' + n + '</strong><span>' + esc(label) + '</span></div>'; }

function recentCasesPanel(list) {
  var recent = list.slice().sort(function(a, b) { return String(b.updated_at || '').localeCompare(String(a.updated_at || '')); }).slice(0, 5);
  if (!recent.length) return '<div class="small-empty">Aucun dossier CID pour le moment.</div>';
  return '<div class="mini-list">' + recent.map(function(c) {
    return '<button class="mini-row" onclick="go(' + js('dossiers') + ',{id:' + js(c.id) + '})"><span>' + esc(c.numero) + '</span><strong>' + esc(c.titre || 'Dossier sans titre') + '</strong>' + statusBadge(c.statut) + '</button>';
  }).join('') + '</div>';
}

function renderDossiers(includeArchived) {
  $('content').innerHTML = renderCaseBoard(includeArchived);
  wireCaseControls();
}

function renderCaseBoard(includeArchived) {
  var list = allFiltered(includeArchived);
  var activeId = STATE.route.id || (list[0] && list[0].id);
  var active = activeId ? caseGet(activeId) : null;
  return [
    '<div class="mdt-grid">',
      '<section class="panel">',
        '<div class="panel-head"><div class="panel-title">Dossiers d\'enquete</div><button class="btn btn-blue btn-small" onclick="openCaseModal()">Nouveau</button></div>',
        '<div class="filters"><input id="caseSearch" placeholder="Rechercher..." value="' + esc(STATE.q) + '"><select id="caseFilter"><option>Toutes</option>' + options(STATUSES, STATE.filter) + '</select></div>',
        '<div class="case-list">' + (list.length ? list.map(function(c) { return caseListItem(c, activeId); }).join('') : '<div class="empty">Aucun dossier.</div>') + '</div>',
      '</section>',
      '<section class="panel">' + renderWorkspace(active) + '</section>',
    '</div>'
  ].join('');
}

function wireCaseControls() {
  var search = $('caseSearch');
  var filter = $('caseFilter');
  if (search) {
    search.addEventListener('input', function() {
      STATE.q = this.value;
      renderContent();
    });
  }
  if (filter) {
    filter.addEventListener('change', function() {
      STATE.filter = this.value;
      renderContent();
    });
  }
}

function caseListItem(c, activeId) {
  return [
    '<article class="case-item ' + (c.id === activeId ? 'active' : '') + '" onclick="go(\'dossiers\',{id:' + JSON.stringify(c.id).replace(/"/g, '&quot;') + '})">',
      '<div class="case-top"><span>' + esc(c.numero) + '</span>' + priorityBadge(c.priorite) + '</div>',
      '<div class="case-name">' + esc(c.titre || 'Dossier sans titre') + '</div>',
      '<div class="case-meta"><span>' + esc(c.responsable || 'CID') + '</span><span>' + esc(c.updated_at || '-') + '</span></div>',
    '</article>'
  ].join('');
}

function renderWorkspace(c) {
  if (!c) return '<div class="empty"><div><h2>Aucun dossier selectionne</h2><p>Selectionne ou cree un dossier CID.</p></div></div>';
  if (STATE.route.person) return renderPersonWorkspace(c, STATE.route.person);
  var people = c.personnes || [];
  var proofs = c.preuves || [];
  var notes = (c.journal || []).filter(function(j) { return j.type === 'note'; });
  return [
    '<div class="workspace">',
      '<div class="workspace-head">',
        '<div><div class="case-id">' + esc(c.numero) + '</div><h1>' + esc(c.titre) + '</h1><div class="subline"><span>Ouvert le ' + esc(c.date_ouverture) + '</span><span>Derniere modif. ' + esc(c.updated_at) + '</span><span>Par ' + esc(c.responsable || 'CID') + '</span></div></div>',
        '<div class="actions"><button class="btn btn-ghost btn-small" onclick="openCaseModal(' + js(c.id) + ')">Modifier</button><button class="btn btn-ghost btn-small" onclick="openNoteModal(' + js(c.id) + ')">Note</button><button class="btn btn-blue btn-small" onclick="openPersonModal(' + js(c.id) + ')">Personne</button><button class="btn btn-gold btn-small" onclick="openEvidenceModal(' + js(c.id) + ')">Preuve</button><button class="btn btn-ghost btn-small" onclick="archiveCase(' + js(c.id) + ')">Archiver</button><button class="btn btn-red btn-small" onclick="deleteCase(' + js(c.id) + ')">Supprimer</button></div>',
      '</div>',
      '<div class="chip-grid">',
        chip('Statut', statusBadge(c.statut)),
        chip('Priorite', priorityBadge(c.priorite)),
        chip('Classification', esc(c.classification || '-')),
        chip('Confidentialite', esc(c.confidentialite || '-')),
      '</div>',
      '<div class="detail-grid">',
        '<section class="panel section"><h2>Personnes</h2>' + peopleTable(c, people) + '</section>',
        '<section class="panel section"><h2>Preuves</h2>' + evidenceTable(c, proofs) + '</section>',
      '</div>',
      '<div class="wide-grid">',
        '<section class="panel section"><h2>Resume / description</h2><p class="text">' + esc(c.resume || c.description || 'Aucun resume renseigne.') + '</p></section>',
        '<section class="panel section"><h2>Notes</h2><div class="note-list">' + (notes.length ? notes.map(noteHtml).join('') : '<div class="note-item">Aucune note.</div>') + '</div></section>',
      '</div>',
    '</div>'
  ].join('');
}

function chip(label, value) { return '<div class="chip"><span>' + esc(label) + '</span><strong>' + value + '</strong></div>'; }
function noteHtml(n) { return '<div class="note-item"><strong>' + esc(n.date || '-') + '</strong>' + esc(n.texte || '') + '</div>'; }
function peopleTable(c, people) {
  if (!people.length) return '<div class="text">Aucune personne liee.</div>';
  return '<table><tbody>' + people.map(function(p) {
    return '<tr class="clickable" onclick="go(\'dossiers\',{id:' + js(c.id) + ',person:' + js(p.id) + '})"><td><strong>' + esc(p.nom) + '</strong></td><td>' + badge(p.type, 'blue') + '</td><td>' + esc(p.tel || '-') + '</td></tr>';
  }).join('') + '</tbody></table>';
}
function evidenceTable(c, proofs) {
  if (!proofs.length) return '<div class="text">Aucune preuve scellee.</div>';
  return '<table><thead><tr><th>Apercu</th><th>Scelle</th><th>Type</th><th>Infos</th></tr></thead><tbody>' + proofs.map(function(e) {
    return '<tr><td>' + attachmentHtml(e.attachment, functionName('previewEvidence', c.id, e.id)) + '</td><td>' + esc(e.scelle || '-') + '</td><td>' + badge(e.type, 'gold') + '</td><td>' + esc(proofDetailsText(c, e) || e.description || '-') + '</td></tr>';
  }).join('') + '</tbody></table>';
}

function renderPersonWorkspace(c, pid) {
  var p = (c.personnes || []).find(function(x) { return x.id === pid; });
  if (!p) return renderWorkspace(c);
  var files = p.fichiers || [];
  return [
    '<div class="workspace person-page">',
      '<div class="workspace-head">',
        '<div><button class="btn btn-ghost btn-small" onclick="go(\'dossiers\',{id:' + js(c.id) + '})">Retour au dossier</button><div class="case-id" style="margin-top:12px">' + esc(c.numero) + ' - Fiche personne</div><h1>' + esc(p.nom) + '</h1><div class="subline"><span>' + esc(p.type || '-') + '</span><span>' + esc(p.tel || '-') + '</span></div></div>',
        '<div class="actions"><button class="btn btn-gold btn-small" onclick="openPersonFileModal(' + js(c.id) + ',' + js(p.id) + ')">Ajouter fichier</button><button class="btn btn-red btn-small" onclick="deletePerson(' + js(c.id) + ',' + js(p.id) + ')">Supprimer</button></div>',
      '</div>',
      '<div class="detail-grid">',
        '<section class="panel section"><h2>Identite</h2>' + personEditForm(c, p) + '</section>',
        '<section class="panel section"><h2>Photos / fichiers</h2><div class="file-grid">' + (files.length ? files.map(function(f) { return fileCard(c, p, f); }).join('') : '<div class="text">Aucun fichier sur cette fiche.</div>') + '</div></section>',
      '</div>',
    '</div>'
  ].join('');
}
function personEditForm(c, p) {
  return '<form id="personEditForm" onsubmit="event.preventDefault();savePersonProfile(' + js(c.id) + ',' + js(p.id) + ')"><div class="form-grid"><input name="nom" value="' + esc(p.nom) + '" placeholder="Nom / prenom"><select name="type">' + options(PERSON_TYPES, p.type || 'Citoyen') + '</select><input name="tel" value="' + esc(p.tel || '') + '" placeholder="Telephone"></div><textarea class="full" name="commentaires" rows="8" style="margin-top:10px" placeholder="Notes, habitudes, signalement, liens...">' + esc(p.commentaires || '') + '</textarea><button class="btn btn-blue btn-small" style="margin-top:10px">Sauvegarder</button></form>';
}
function fileCard(c, p, f) {
  var media = attachmentHtml(f.attachment, functionName('previewPersonFile', c.id, p.id, f.id));
  return '<article class="file-card">' + media + '<strong>' + esc(f.type || 'Fichier') + '</strong><br><small>' + esc(f.date || '-') + '</small><p class="text">' + esc(f.note || '') + '</p></article>';
}

function renderPeopleIndex() {
  var rows = [];
  casesLoad().forEach(function(c) { (c.personnes || []).forEach(function(p) { rows.push({ c: c, p: p }); }); });
  $('content').innerHTML = '<section class="panel section"><h2>Personnes CID</h2><table><thead><tr><th>Nom</th><th>Type</th><th>Telephone</th><th>Dossier</th></tr></thead><tbody>' + (rows.length ? rows.map(function(r) { return '<tr class="clickable" onclick="go(\'dossiers\',{id:' + js(r.c.id) + ',person:' + js(r.p.id) + '})"><td><strong>' + esc(r.p.nom) + '</strong></td><td>' + badge(r.p.type, 'blue') + '</td><td>' + esc(r.p.tel || '-') + '</td><td>' + esc(r.c.numero) + ' - ' + esc(r.c.titre) + '</td></tr>'; }).join('') : '<tr><td colspan="4">Aucune personne.</td></tr>') + '</tbody></table></section>';
}
function renderEvidenceIndex() {
  var rows = [];
  casesLoad().forEach(function(c) { (c.preuves || []).forEach(function(e) { rows.push({ c: c, e: e }); }); });
  $('content').innerHTML = '<section class="panel section"><h2>Preuves CID</h2><table><thead><tr><th>Apercu</th><th>Scelle</th><th>Type</th><th>Infos</th><th>Dossier</th></tr></thead><tbody>' + (rows.length ? rows.map(function(r) { return '<tr><td>' + attachmentHtml(r.e.attachment, functionName('previewEvidence', r.c.id, r.e.id)) + '</td><td>' + esc(r.e.scelle) + '</td><td>' + badge(r.e.type, 'gold') + '</td><td>' + esc(proofDetailsText(r.c, r.e) || r.e.description || '-') + '</td><td>' + esc(r.c.numero) + '</td></tr>'; }).join('') : '<tr><td colspan="5">Aucune preuve.</td></tr>') + '</tbody></table></section>';
}

function badge(text, tone) { return '<span class="badge ' + (tone || '') + '">' + esc(text || '-') + '</span>'; }
function statusBadge(v) { return badge(v || '-', /ferme|classe/i.test(v || '') ? 'green' : v === 'En attente' ? 'orange' : 'blue'); }
function priorityBadge(v) { return badge(v || 'Normale', v === 'Critique' ? 'red' : v === 'Haute' ? 'orange' : v === 'Faible' ? 'green' : 'gold'); }
function js(v) { return JSON.stringify(v); }
function functionName(name) {
  var args = Array.prototype.slice.call(arguments, 1).map(js).join(',');
  return name + '(' + args + ')';
}

function openModal(title, body, footer) {
  $('modalRoot').innerHTML = '<section class="modal"><div class="modal-head"><h2>' + esc(title) + '</h2><button class="btn btn-ghost btn-small" onclick="closeModal()">X</button></div><div class="modal-body">' + body + '</div><div class="modal-foot">' + footer + '</div></section>';
  $('modalRoot').classList.add('show');
}
function closeModal() { $('modalRoot').classList.remove('show'); $('modalRoot').innerHTML = ''; }

function openCaseModal(id) {
  var c = id ? caseGet(id) : null;
  openModal(c ? 'Modifier le dossier' : 'Creer un dossier',
    '<form id="caseForm"><div class="form-grid">' +
      field('Titre de l\'enquete', '<input name="titre" placeholder="Nom du dossier / enquete" value="' + esc(c && c.titre || '') + '" required>') +
      field('Statut du dossier', '<select name="statut">' + options(STATUSES, c && c.statut || 'Ouvert') + '</select>') +
      field('Priorite', '<select name="priorite">' + options(PRIORITIES, c && c.priorite || 'Normale') + '</select>') +
      field('Classification', '<select name="classification">' + options(CLASSIFICATIONS, c && c.classification || 'Autre') + '</select>') +
      field('Confidentialite', '<select name="confidentialite">' + options(CONFIDENTIALITIES, c && c.confidentialite || 'CID uniquement') + '</select>') +
      field('Responsable', '<input name="responsable" placeholder="Agent responsable" value="' + esc(c && c.responsable || displayName()) + '">') +
      field('Resume rapide', '<textarea name="resume" rows="3" placeholder="Resume court du dossier">' + esc(c && c.resume || '') + '</textarea>', 'full') +
      field('Description complete', '<textarea name="description" rows="6" placeholder="Faits, contexte, elements connus...">' + esc(c && c.description || '') + '</textarea>', 'full') +
    '</div></form>',
    '<button class="btn btn-ghost" onclick="closeModal()">Annuler</button><button class="btn btn-gold" onclick="saveCase(' + js(id || '') + ')">Sauvegarder</button>'
  );
}

function field(label, control, extraClass) {
  return '<label class="field ' + esc(extraClass || '') + '"><span>' + esc(label) + '</span>' + control + '</label>';
}

function saveCase(id) {
  var f = $('caseForm');
  var fd = new FormData(f);
  var list = casesLoad();
  var old = id ? caseGet(id) : null;
  var data = Object.assign(old || {}, {
    id: id || uid('case'),
    numero: old && old.numero || nextNumber(list),
    titre: fd.get('titre') || 'Dossier sans titre',
    statut: fd.get('statut') || 'Ouvert',
    priorite: fd.get('priorite') || 'Normale',
    classification: fd.get('classification') || 'Autre',
    confidentialite: fd.get('confidentialite') || 'CID uniquement',
    responsable: fd.get('responsable') || displayName(),
    resume: fd.get('resume') || '',
    description: fd.get('description') || '',
    date_ouverture: old && old.date_ouverture || nowLabel(),
    personnes: old && old.personnes || [],
    preuves: old && old.preuves || [],
    journal: old && old.journal || []
  });
  caseUpsert(data);
  closeModal();
  STATE.route = { page: 'dossiers', id: data.id };
  renderApp();
}

function openPersonModal(caseId) {
  openModal('Ajouter une personne',
    '<form id="personForm"><div class="form-grid">' +
      '<input name="nom" placeholder="Nom / prenom" required>' +
      '<select name="type">' + options(PERSON_TYPES, 'Suspect') + '</select>' +
      '<input name="tel" placeholder="Numero de telephone">' +
      '<textarea class="full" name="commentaires" rows="4" placeholder="Commentaires CID"></textarea>' +
    '</div></form>',
    '<button class="btn btn-ghost" onclick="closeModal()">Annuler</button><button class="btn btn-gold" onclick="savePerson(' + js(caseId) + ')">Ajouter</button>'
  );
}
function savePerson(caseId) {
  var c = caseGet(caseId);
  var fd = new FormData($('personForm'));
  var p = { id: uid('person'), nom: fd.get('nom'), type: fd.get('type'), tel: fd.get('tel') || '', commentaires: fd.get('commentaires') || '', fichiers: [] };
  c.personnes = c.personnes || [];
  c.personnes.push(p);
  c.journal = c.journal || [];
  c.journal.unshift({ date: nowLabel(), texte: 'Personne ajoutee: ' + p.nom, type: 'system' });
  caseUpsert(c);
  closeModal();
  STATE.route = { page: 'dossiers', id: c.id, person: p.id };
  renderApp();
}
function savePersonProfile(caseId, pid) {
  var c = caseGet(caseId);
  var p = c.personnes.find(function(x) { return x.id === pid; });
  var fd = new FormData($('personEditForm'));
  p.nom = fd.get('nom') || p.nom;
  p.type = fd.get('type') || p.type;
  p.tel = fd.get('tel') || '';
  p.commentaires = fd.get('commentaires') || '';
  caseUpsert(c);
  renderApp();
}
function deletePerson(caseId, pid) {
  if (!confirm('Supprimer cette personne du dossier ?')) return;
  var c = caseGet(caseId);
  c.personnes = (c.personnes || []).filter(function(p) { return p.id !== pid; });
  caseUpsert(c);
  STATE.route = { page: 'dossiers', id: caseId };
  renderApp();
}

function openEvidenceModal(caseId) {
  var c = caseGet(caseId);
  var suspects = '<option value="">Non attribue</option>' + (c.personnes || []).filter(function(p) { return p.type === 'Suspect'; }).map(function(p) { return '<option value="' + esc(p.id) + '">' + esc(p.nom) + '</option>'; }).join('');
  openModal('Ajouter une preuve',
    '<form id="evidenceForm"><div class="form-grid">' +
      '<select name="type" id="evidenceType" onchange="toggleEvidenceFields()">' + options(EVIDENCE_TYPES, 'Photo') + '</select>' +
      '<div id="fileField"><input name="fichier" type="file" accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.txt"></div>' +
      '<div id="weaponFields" class="form-grid full hidden"><input name="type_arme" placeholder="Type d\'arme"><input name="numero_serie" placeholder="Numero de serie"><select name="suspect_arme">' + suspects + '</select></div>' +
      '<div id="drugFields" class="form-grid full hidden"><input name="type_drogue" placeholder="Type de drogue"><input name="quantite" placeholder="Quantite"><select name="suspect_drogue">' + suspects + '</select></div>' +
      '<div id="vehicleFields" class="form-grid full hidden"><input name="modele" placeholder="Modele du vehicule"><input name="plaque" placeholder="Plaque"><select name="suspect_vehicule">' + suspects + '</select></div>' +
      '<textarea class="full" name="description" rows="4" placeholder="Description / contexte"></textarea>' +
    '</div></form>',
    '<button class="btn btn-ghost" onclick="closeModal()">Annuler</button><button class="btn btn-gold" onclick="saveEvidence(' + js(caseId) + ')">Ajouter</button>'
  );
  toggleEvidenceFields();
}
function toggleEvidenceFields() {
  var type = $('evidenceType').value;
  ['weaponFields', 'drugFields', 'vehicleFields'].forEach(function(id) { $(id).classList.add('hidden'); });
  if (type === 'Arme') $('weaponFields').classList.remove('hidden');
  if (type === 'Drogue') $('drugFields').classList.remove('hidden');
  if (type === 'Vehicule') $('vehicleFields').classList.remove('hidden');
  $('fileField').classList.toggle('hidden', ['Photo','Document','ADN','Douille','Empreinte'].indexOf(type) === -1);
}
async function readFile(input) {
  var file = input && input.files && input.files[0];
  if (!file) return null;
  return new Promise(function(resolve, reject) {
    var r = new FileReader();
    r.onload = function() { resolve({ name: file.name, type: file.type, data: r.result }); };
    r.onerror = function() { reject(new Error('Lecture fichier impossible.')); };
    r.readAsDataURL(file);
  });
}
async function saveEvidence(caseId) {
  var c = caseGet(caseId);
  var f = $('evidenceForm');
  var fd = new FormData(f);
  var type = fd.get('type');
  var details = {};
  if (type === 'Arme') details = { type_arme: fd.get('type_arme') || '', numero_serie: fd.get('numero_serie') || '', suspect_id: fd.get('suspect_arme') || '' };
  if (type === 'Drogue') details = { type_drogue: fd.get('type_drogue') || '', quantite: fd.get('quantite') || '', suspect_id: fd.get('suspect_drogue') || '' };
  if (type === 'Vehicule') details = { modele: fd.get('modele') || '', plaque: fd.get('plaque') || '', suspect_id: fd.get('suspect_vehicule') || '' };
  var seal = 'SC-' + new Date().getFullYear() + '-' + String((c.preuves || []).length + 1).padStart(4, '0');
  var attachment = await readFile(f.querySelector('input[type=file]'));
  c.preuves = c.preuves || [];
  c.preuves.push({ id: uid('evidence'), scelle: seal, type: type, description: fd.get('description') || '', details: details, attachment: attachment, date: nowLabel() });
  c.journal = c.journal || [];
  c.journal.unshift({ date: nowLabel(), texte: 'Preuve ajoutee: ' + seal, type: 'system' });
  caseUpsert(c);
  closeModal();
  renderApp();
}

function openNoteModal(caseId) {
  openModal('Ajouter une note', '<form id="noteForm"><textarea name="note" rows="6" placeholder="Note CID..." required></textarea></form>', '<button class="btn btn-ghost" onclick="closeModal()">Annuler</button><button class="btn btn-gold" onclick="saveNote(' + js(caseId) + ')">Ajouter</button>');
}
function saveNote(caseId) {
  var c = caseGet(caseId);
  var txt = new FormData($('noteForm')).get('note');
  c.journal = c.journal || [];
  c.journal.unshift({ date: nowLabel(), texte: txt, type: 'note' });
  caseUpsert(c);
  closeModal();
  renderApp();
}

function openPersonFileModal(caseId, pid) {
  openModal('Ajouter un fichier personne', '<form id="personFileForm"><div class="form-grid"><select name="type">' + options(['Photo','Video','Audio','Document','Autre'], 'Photo') + '</select><input name="fichier" type="file" accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.txt" required><textarea class="full" name="note" rows="3" placeholder="Note"></textarea></div></form>', '<button class="btn btn-ghost" onclick="closeModal()">Annuler</button><button class="btn btn-gold" onclick="savePersonFile(' + js(caseId) + ',' + js(pid) + ')">Ajouter</button>');
}
async function savePersonFile(caseId, pid) {
  var c = caseGet(caseId);
  var p = c.personnes.find(function(x) { return x.id === pid; });
  var f = $('personFileForm');
  var fd = new FormData(f);
  var attachment = await readFile(f.querySelector('input[type=file]'));
  p.fichiers = p.fichiers || [];
  p.fichiers.push({ id: uid('file'), type: fd.get('type'), note: fd.get('note') || '', attachment: attachment, date: nowLabel() });
  caseUpsert(c);
  closeModal();
  renderApp();
}

function previewEvidence(caseId, evidenceId) {
  var c = caseGet(caseId);
  var e = c && (c.preuves || []).find(function(x) { return x.id === evidenceId; });
  previewAttachment(e && e.attachment);
}
function previewPersonFile(caseId, pid, fileId) {
  var c = caseGet(caseId);
  var p = c && (c.personnes || []).find(function(x) { return x.id === pid; });
  var f = p && (p.fichiers || []).find(function(x) { return x.id === fileId; });
  previewAttachment(f && f.attachment);
}
function attachmentHtml(file, action) {
  if (!file || !file.data) return '<span class="text">-</span>';
  if (String(file.type || '').indexOf('image/') === 0) return '<button class="btn btn-ghost btn-small" onclick="' + action + '"><img class="preview-img" src="' + file.data + '" alt=""></button>';
  return '<button class="btn btn-ghost btn-small" onclick="' + action + '">' + esc(file.name || 'Fichier') + '</button>';
}
function previewAttachment(file) {
  if (!file || !file.data) return;
  var body = '';
  if (String(file.type || '').indexOf('image/') === 0) body = '<img src="' + file.data + '" style="max-width:100%;max-height:72vh;border-radius:8px">';
  else if (String(file.type || '').indexOf('video/') === 0) body = '<video controls src="' + file.data + '" style="max-width:100%;max-height:72vh;border-radius:8px"></video>';
  else if (String(file.type || '').indexOf('audio/') === 0) body = '<audio controls src="' + file.data + '" style="width:100%"></audio>';
  else body = '<a class="btn btn-blue" download="' + esc(file.name || 'fichier') + '" href="' + file.data + '">Telecharger</a>';
  openModal(file.name || 'Apercu', '<div style="text-align:center">' + body + '</div>', '<button class="btn btn-ghost" onclick="closeModal()">Fermer</button>');
}

function proofDetailsText(c, e) {
  var d = e.details || {};
  if (e.type === 'Arme') return [d.type_arme, d.numero_serie ? 'Serie ' + d.numero_serie : '', personName(c, d.suspect_id)].filter(Boolean).join(' - ');
  if (e.type === 'Drogue') return [d.type_drogue, d.quantite, personName(c, d.suspect_id)].filter(Boolean).join(' - ');
  if (e.type === 'Vehicule') return [d.modele, d.plaque ? 'Plaque ' + d.plaque : '', personName(c, d.suspect_id)].filter(Boolean).join(' - ');
  return e.description || '';
}
function personName(c, id) {
  var p = c && (c.personnes || []).find(function(x) { return x.id === id; });
  return p ? p.nom : '';
}
function displayName() {
  return STATE.user && STATE.user.user_metadata && (STATE.user.user_metadata.full_name || STATE.user.user_metadata.name) || 'CID';
}
function archiveCase(id) {
  var c = caseGet(id);
  if (!c) return;
  c.statut = 'Classe';
  caseUpsert(c);
  renderApp();
}
function deleteCase(id) {
  if (!confirm('Supprimer definitivement ce dossier CID ?')) return;
  casesSave(casesLoad().filter(function(c) { return c.id !== id; }));
  STATE.route = { page: 'dossiers' };
  renderApp();
}

boot();

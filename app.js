var WORKER_BASE = 'https://sasp-intranet-bot.louisleurin.workers.dev';
var CID_STORE_KEY = 'sasp_cid_cases_v2';
var MAX_ATTACHMENT_BYTES = 1800000;
var EFFECTIVE_CID_ROLE_ID = window.CID_ROLE_ID || '1518631634524569641';
var CID_INVESTIGATOR_ROLE_ID = '1518631634524569641';
var CID_DELETE_ROLE_ID = '1501526499910746132';
var DISCORD_ROLE_MEMBER_CACHE = {};

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
var PERSON_TYPES = ['Citoyen', 'Suspect', 'Victime', 'Temoin', 'Informateur', 'Enqueteur'];
var EVIDENCE_TYPES = ['Photo', 'Document', 'ADN', 'Douille', 'Empreinte', 'Arme', 'Drogue', 'Vehicule', 'Objet', 'Telephone', 'Temoignage', 'Autre'];
var CID_OPTIONS_KEY = 'sasp_cid_managed_options_v1';
var OPTION_GROUPS = {
  priorites: { title: 'Priorites', defaults: PRIORITIES },
  classifications: { title: 'Classifications', defaults: CLASSIFICATIONS },
  confidentialites: { title: 'Confidentialites', defaults: CONFIDENTIALITIES },
  types_preuves: { title: 'Types de preuve', defaults: EVIDENCE_TYPES }
};

function $(id) { return document.getElementById(id); }
function esc(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, function(c) {
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
  });
}
function js(v) { return JSON.stringify(v); }
function attrJs(v) { return esc(js(v)); }
function callAttr(name) {
  var args = Array.prototype.slice.call(arguments, 1).map(attrJs).join(',');
  return name + '(' + args + ')';
}
function nowLabel() {
  var d = new Date();
  return d.toISOString().slice(0, 16).replace('T', ' ');
}
function uid(prefix) { return prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7); }
function options(list, selected) {
  return list.map(function(v) { return '<option value="' + esc(v) + '"' + (v === selected ? ' selected' : '') + '>' + esc(v) + '</option>'; }).join('');
}

function managedOptionsLoad() {
  try { return JSON.parse(localStorage.getItem(CID_OPTIONS_KEY) || '{}'); }
  catch(e) { return {}; }
}

function managedOptionsSave(data) {
  localStorage.setItem(CID_OPTIONS_KEY, JSON.stringify(data));
}

function managedOptions(key) {
  var group = OPTION_GROUPS[key];
  var saved = managedOptionsLoad()[key];
  return (saved && saved.length ? saved : group.defaults).slice();
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
function hasAdminRole() {
  return STATE.roles.some(function(r) { return ROLE_ADMIN_IDS.indexOf(r) !== -1; });
}
function canDeleteCases() {
  return hasAdminRole() || STATE.roles.indexOf(CID_DELETE_ROLE_ID) !== -1;
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
        '<img class="login-logo" src="assets/cid-logo.png" alt="CID">',
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
        '<div class="brand"><img src="assets/cid-logo.png" alt="CID"><div><strong>SASP CID</strong><span>Criminal Investigation</span></div></div>',
        '<div class="profile-block"><span>Administrateur</span><strong>' + esc(userName) + '</strong><em>Acces CID</em></div>',
        '<div class="sidebar-foot"><strong>Discord</strong><br>Connecte et autorise</div>',
        '<nav class="nav">',
          '<div class="nav-title">Menu principal</div>',
          navButton('dashboard', 'Accueil', '⌂'),
          '<div class="nav-group"><span>CID</span></div>',
          navButton('dossiers', 'Dossiers', '▣'),
          navButton('personnes', 'Personnes', '♙'),
          navButton('preuves', 'Preuves', '◆'),
          navButton('gestion', 'Gestion', '⚙'),
          '<div class="nav-group"><span>Historique</span></div>',
          navButton('archives', 'Archives', '▤'),
        '</nav>',
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
    if (STATE.q.trim()) STATE.route = { page: 'search' };
    renderContent();
  });
  renderContent();
}

function navButton(page, label, icon) {
  return '<button class="' + (STATE.route.page === page ? 'active' : '') + '" onclick="' + callAttr('go', page) + '"><span class="nav-icon">' + esc(icon || '-') + '</span>' + esc(label) + '</button>';
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
  if (STATE.route.page === 'search') return renderSearchResults();
  if (STATE.route.page === 'dashboard') return renderDashboard();
  if (STATE.route.page === 'personnes') return renderPeopleIndex();
  if (STATE.route.page === 'preuves') return renderEvidenceIndex();
  if (STATE.route.page === 'gestion') return renderGestion();
  if (STATE.route.page === 'archives') return renderDossiers(true);
  renderDossiers(false);
}

function matchText(value, q) {
  return String(value || '').toLowerCase().indexOf(q) !== -1;
}
function searchContext(fields, q) {
  for (var i = 0; i < fields.length; i++) {
    if (matchText(fields[i], q)) return fields[i];
  }
  return fields.filter(Boolean).join(' - ');
}
function renderSearchResults() {
  var q = STATE.q.trim().toLowerCase();
  var results = [];
  if (q) {
    casesLoad().forEach(function(c) {
      if (matchText([c.numero, c.titre, c.statut, c.priorite, c.classification, c.confidentialite, c.resume, c.description, c.responsable].join(' '), q)) {
        results.push({ type: 'Dossier', title: (c.numero || '-') + ' - ' + (c.titre || 'Dossier sans titre'), meta: searchContext([c.resume, c.description, c.statut, c.priorite, c.classification], q), action: callAttr('openSearchResult', 'dossiers', { id: c.id }) });
      }
      (c.personnes || []).forEach(function(p) {
        if (matchText([p.nom, p.type, p.tel, p.discord_id, p.commentaires].join(' '), q)) {
          results.push({ type: 'Personne', title: p.nom || 'Personne sans nom', meta: (c.numero || '-') + ' - ' + searchContext([p.type, p.tel, p.commentaires], q), action: callAttr('openSearchResult', 'dossiers', { id: c.id, person: p.id }) });
        }
        (p.fichiers || []).forEach(function(f) {
          if (matchText([f.type, f.note, f.attachment && f.attachment.name].join(' '), q)) {
            results.push({ type: 'Fichier personne', title: (f.attachment && f.attachment.name) || f.type || 'Fichier', meta: (p.nom || '-') + ' - ' + searchContext([f.type, f.note], q), action: callAttr('openSearchResult', 'dossiers', { id: c.id, person: p.id }) });
          }
        });
      });
      (c.preuves || []).forEach(function(e) {
        var detail = proofDetailsText(c, e);
        if (matchText([e.scelle, e.type, e.description, detail, e.attachment && e.attachment.name].join(' '), q)) {
          results.push({ type: 'Preuve', title: (e.scelle || '-') + ' - ' + (e.type || '-'), meta: (c.numero || '-') + ' - ' + searchContext([detail, e.description, e.attachment && e.attachment.name], q), action: callAttr('openSearchResult', 'dossiers', { id: c.id }) });
        }
      });
      (c.journal || []).filter(function(j) { return j.type === 'note'; }).forEach(function(j) {
        if (matchText([j.date, j.texte].join(' '), q)) {
          results.push({ type: 'Note', title: c.numero + ' - Note du ' + (j.date || '-'), meta: j.texte || '', action: callAttr('openSearchResult', 'dossiers', { id: c.id }) });
        }
      });
    });
  }
  $('content').innerHTML = [
    '<section class="panel section search-results-panel">',
      '<div class="panel-head flush-head"><div><div class="kicker">Recherche CID</div><h1>Resultats pour "' + esc(STATE.q.trim()) + '"</h1></div><button class="btn btn-ghost btn-small" onclick="clearGlobalSearch()">Effacer</button></div>',
      results.length ? '<div class="search-results">' + results.map(function(r) {
        return '<button class="search-result" onclick="' + r.action + '"><span>' + esc(r.type) + '</span><strong>' + esc(r.title) + '</strong><p>' + esc(r.meta || '-') + '</p></button>';
      }).join('') + '</div>' : '<div class="empty small-search-empty">Aucun resultat trouve.</div>',
    '</section>'
  ].join('');
}
function clearGlobalSearch() {
  STATE.q = '';
  STATE.route = { page: 'dashboard' };
  renderApp();
}
function openSearchResult(page, extra) {
  STATE.q = '';
  STATE.route = Object.assign({ page: page }, extra || {});
  renderApp();
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
      '<div class="panel-head flush-head"><div class="panel-title">Derniers dossiers</div><button class="btn btn-ghost btn-small" onclick="' + callAttr('go', 'dossiers') + '">Ouvrir les dossiers</button></div>',
      recentCasesPanel(list),
    '</section>'
    ].join('');
}
function stat(n, label) { return '<div class="stat-card"><strong>' + n + '</strong><span>' + esc(label) + '</span></div>'; }

function recentCasesPanel(list) {
  var recent = list.slice().sort(function(a, b) { return String(b.updated_at || '').localeCompare(String(a.updated_at || '')); }).slice(0, 5);
  if (!recent.length) return '<div class="small-empty">Aucun dossier CID pour le moment.</div>';
  return '<div class="mini-list">' + recent.map(function(c) {
    return '<button class="mini-row" onclick="' + callAttr('go', 'dossiers', { id: c.id }) + '"><span>' + esc(c.numero) + '</span><strong>' + esc(c.titre || 'Dossier sans titre') + '</strong>' + statusBadge(c.statut) + '</button>';
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
    '<article class="case-item ' + (c.id === activeId ? 'active' : '') + '" onclick="' + callAttr('go', 'dossiers', { id: c.id }) + '">',
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
        '<div class="case-command-bar">' +
          commandButton('EDIT', 'Modifier', 'neutral', callAttr('openCaseModal', c.id)) +
          commandButton('NOTE', 'Note', 'neutral', callAttr('openNoteModal', c.id)) +
          commandButton('PERS', 'Personne', 'blue', callAttr('openPersonModal', c.id)) +
          commandButton('SCELLE', 'Preuve', 'gold', callAttr('openEvidenceModal', c.id)) +
          '<span class="command-divider"></span>' +
          commandButton('ARCH', 'Archiver', 'neutral', callAttr('archiveCase', c.id)) +
          (canDeleteCases() ? commandButton('DEL', 'Supprimer', 'danger', callAttr('deleteCase', c.id)) : '') +
        '</div>',
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
function commandButton(code, label, tone, action) {
  return '<button type="button" class="command-btn ' + esc(tone || 'neutral') + '" onclick="' + action + '"><span>' + esc(code) + '</span><strong>' + esc(label) + '</strong></button>';
}
function noteHtml(n) { return '<div class="note-item"><strong>' + esc(n.date || '-') + '</strong>' + esc(n.texte || '') + '</div>'; }
function peopleTable(c, people) {
  if (!people.length) return '<div class="text">Aucune personne liee.</div>';
  return '<table><tbody>' + people.map(function(p) {
    return '<tr class="clickable" onclick="' + callAttr('go', 'dossiers', { id: c.id, person: p.id }) + '"><td><strong>' + esc(p.nom) + '</strong></td><td>' + badge(p.type, 'blue') + '</td><td>' + esc(p.tel || '-') + '</td></tr>';
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
        '<div><button class="btn btn-ghost btn-small" onclick="' + callAttr('go', 'dossiers', { id: c.id }) + '">Retour au dossier</button><div class="case-id" style="margin-top:12px">' + esc(c.numero) + ' - Fiche personne</div><h1>' + esc(p.nom) + '</h1><div class="subline"><span>' + esc(p.type || '-') + '</span><span>' + esc(p.tel || '-') + '</span></div></div>',
        '<div class="actions"><button class="btn btn-gold btn-small" onclick="' + callAttr('openPersonFileModal', c.id, p.id) + '">Ajouter fichier</button><button class="btn btn-red btn-small" onclick="' + callAttr('deletePerson', c.id, p.id) + '">Supprimer</button></div>',
      '</div>',
      '<div class="detail-grid">',
        '<section class="panel section"><h2>Identite</h2>' + personEditForm(c, p) + '</section>',
        '<section class="panel section"><h2>Photos / fichiers</h2><div class="file-grid">' + (files.length ? files.map(function(f) { return fileCard(c, p, f); }).join('') : '<div class="text">Aucun fichier sur cette fiche.</div>') + '</div></section>',
      '</div>',
    '</div>'
  ].join('');
}
function personEditForm(c, p) {
  return '<form id="personEditForm" class="person-edit-form" onsubmit="event.preventDefault();' + callAttr('savePersonProfile', c.id, p.id) + '"><div class="form-grid"><input name="nom" value="' + esc(p.nom) + '" placeholder="Nom / prenom"><select name="type">' + options(PERSON_TYPES, p.type || 'Citoyen') + '</select><input name="tel" value="' + esc(p.tel || '') + '" placeholder="Telephone"></div><textarea name="commentaires" rows="10" placeholder="Notes, habitudes, signalement, liens...">' + esc(p.commentaires || '') + '</textarea><button class="btn btn-blue btn-small">Sauvegarder</button></form>';
}
function fileCard(c, p, f) {
  var media = attachmentHtml(f.attachment, functionName('previewPersonFile', c.id, p.id, f.id));
  return '<article class="file-card">' + media + '<strong>' + esc(f.type || 'Fichier') + '</strong><br><small>' + esc(f.date || '-') + '</small><p class="text">' + esc(f.note || '') + '</p></article>';
}

function renderPeopleIndex() {
  var rows = [];
  casesLoad().forEach(function(c) { (c.personnes || []).forEach(function(p) { rows.push({ c: c, p: p }); }); });
  $('content').innerHTML = '<section class="panel section"><h2>Personnes CID</h2><table><thead><tr><th>Nom</th><th>Type</th><th>Telephone</th><th>Dossier</th></tr></thead><tbody>' + (rows.length ? rows.map(function(r) { return '<tr class="clickable" onclick="' + callAttr('go', 'dossiers', { id: r.c.id, person: r.p.id }) + '"><td><strong>' + esc(r.p.nom) + '</strong></td><td>' + badge(r.p.type, 'blue') + '</td><td>' + esc(r.p.tel || '-') + '</td><td>' + esc(r.c.numero) + ' - ' + esc(r.c.titre) + '</td></tr>'; }).join('') : '<tr><td colspan="4">Aucune personne.</td></tr>') + '</tbody></table></section>';
}
function renderEvidenceIndex() {
  var rows = [];
  casesLoad().forEach(function(c) { (c.preuves || []).forEach(function(e) { rows.push({ c: c, e: e }); }); });
  $('content').innerHTML = '<section class="panel section"><h2>Preuves CID</h2><table><thead><tr><th>Apercu</th><th>Scelle</th><th>Type</th><th>Infos</th><th>Dossier</th></tr></thead><tbody>' + (rows.length ? rows.map(function(r) { return '<tr><td>' + attachmentHtml(r.e.attachment, functionName('previewEvidence', r.c.id, r.e.id)) + '</td><td>' + esc(r.e.scelle) + '</td><td>' + badge(r.e.type, 'gold') + '</td><td>' + esc(proofDetailsText(r.c, r.e) || r.e.description || '-') + '</td><td>' + esc(r.c.numero) + '</td></tr>'; }).join('') : '<tr><td colspan="5">Aucune preuve.</td></tr>') + '</tbody></table></section>';
}

function renderGestion() {
  $('content').innerHTML = [
    '<section class="panel section">',
      '<div class="panel-head flush-head"><div><div class="kicker">Configuration CID</div><h1>Gestion des listes</h1></div></div>',
      '<p class="text">Modifie les choix disponibles dans les dossiers CID. Les changements s\'appliquent aux nouveaux dossiers et aux prochaines modifications.</p>',
      '<div class="gestion-grid">',
        managedOptionPanel('priorites', 'Priorites', 'Ex : Urgent, Surveillance, Analyse'),
        managedOptionPanel('classifications', 'Classifications', 'Ex : Homicide, Stupefiants, Braquage'),
        managedOptionPanel('confidentialites', 'Confidentialites', 'Niveau de diffusion du dossier'),
        managedOptionPanel('types_preuves', 'Types de preuve', 'Ex : Photo, Douille, Vehicule'),
      '</div>',
    '</section>'
  ].join('');
}

function managedOptionPanel(key, title, placeholder) {
  var list = managedOptions(key);
  return [
    '<section class="option-panel">',
      '<div class="option-head"><h2>' + esc(title) + '</h2><button class="btn btn-ghost btn-small" onclick="' + callAttr('resetManagedOptions', key) + '">Reset</button></div>',
      '<div class="option-list">',
        list.map(function(value) {
          return '<div class="option-row"><span>' + esc(value) + '</span><button class="btn btn-red btn-small" onclick="' + callAttr('deleteManagedOption', key, value) + '">Supprimer</button></div>';
        }).join(''),
      '</div>',
      '<div class="option-add"><input id="add_' + esc(key) + '" placeholder="' + esc(placeholder) + '"><button class="btn btn-gold btn-small" onclick="' + callAttr('addManagedOption', key) + '">Ajouter</button></div>',
    '</section>'
  ].join('');
}

function addManagedOption(key) {
  var input = $('add_' + key);
  var value = input && input.value.trim();
  if (!value) return;
  var data = managedOptionsLoad();
  var list = managedOptions(key);
  if (!list.some(function(v) { return v.toLowerCase() === value.toLowerCase(); })) list.push(value);
  data[key] = list;
  managedOptionsSave(data);
  renderGestion();
}

function deleteManagedOption(key, value) {
  var data = managedOptionsLoad();
  data[key] = managedOptions(key).filter(function(v) { return v !== value; });
  managedOptionsSave(data);
  renderGestion();
}

function resetManagedOptions(key) {
  var data = managedOptionsLoad();
  delete data[key];
  managedOptionsSave(data);
  renderGestion();
}

function badge(text, tone) { return '<span class="badge ' + (tone || '') + '">' + esc(text || '-') + '</span>'; }
function statusBadge(v) { return badge(v || '-', /ferme|classe/i.test(v || '') ? 'green' : v === 'En attente' ? 'orange' : 'blue'); }
function priorityBadge(v) { return badge(v || 'Normale', v === 'Critique' ? 'red' : v === 'Haute' ? 'orange' : v === 'Faible' ? 'green' : 'gold'); }
function functionName(name) {
  return callAttr.apply(null, arguments);
}

function openModal(title, body, footer) {
  $('modalRoot').innerHTML = '<section class="modal"><div class="modal-head"><h2>' + esc(title) + '</h2><button type="button" class="btn btn-ghost btn-small" onclick="closeModal()">X</button></div><div class="modal-body">' + body + '</div><div class="modal-foot">' + footer + '</div></section>';
  $('modalRoot').classList.add('show');
}
function closeModal() { $('modalRoot').classList.remove('show'); $('modalRoot').innerHTML = ''; }
function openConfirmModal(title, message, tone, action) {
  openModal(title,
    '<div class="confirm-box ' + esc(tone || '') + '">' +
      '<div class="confirm-icon">' + (tone === 'danger' ? '!' : 'i') + '</div>' +
      '<div><strong>' + esc(title) + '</strong><p>' + esc(message) + '</p></div>' +
    '</div>',
    '<button type="button" class="btn btn-ghost" onclick="closeModal()">Annuler</button><button type="button" class="btn ' + (tone === 'danger' ? 'btn-red' : 'btn-gold') + '" onclick="' + action + '">Confirmer</button>'
  );
}
function openInfoModal(title, message) {
  openModal(title,
    '<div class="confirm-box"><div class="confirm-icon">i</div><div><strong>' + esc(title) + '</strong><p>' + esc(message) + '</p></div></div>',
    '<button type="button" class="btn btn-gold" onclick="closeModal()">OK</button>'
  );
}

function openCaseModal(id) {
  var c = id ? caseGet(id) : null;
  openModal(c ? 'Modifier le dossier' : 'Creer un dossier',
    '<form id="caseForm"><div class="form-grid">' +
      field('Titre de l\'enquete', '<input name="titre" placeholder="Nom du dossier / enquete" value="' + esc(c && c.titre || '') + '" required>') +
      field('Statut du dossier', '<select name="statut">' + options(STATUSES, c && c.statut || 'Ouvert') + '</select>') +
      field('Priorite', '<select name="priorite">' + options(managedOptions('priorites'), c && c.priorite || 'Normale') + '</select>') +
      field('Classification', '<select name="classification">' + options(managedOptions('classifications'), c && c.classification || 'Autre') + '</select>') +
      field('Confidentialite', '<select name="confidentialite">' + options(managedOptions('confidentialites'), c && c.confidentialite || 'CID uniquement') + '</select>') +
      field('Responsable', '<input name="responsable" placeholder="Agent responsable" value="' + esc(c && c.responsable || displayName()) + '">') +
      field('Resume rapide', '<textarea name="resume" rows="3" placeholder="Resume court du dossier">' + esc(c && c.resume || '') + '</textarea>', 'full') +
      field('Description complete', '<textarea name="description" rows="6" placeholder="Faits, contexte, elements connus...">' + esc(c && c.description || '') + '</textarea>', 'full') +
    '</div></form>',
    '<button type="button" class="btn btn-ghost" onclick="closeModal()">Annuler</button><button type="button" class="btn btn-gold" onclick="' + (id ? callAttr('saveCase', id) : 'saveCase()') + '">Sauvegarder</button>'
  );
}

function field(label, control, extraClass) {
  return '<label class="field ' + esc(extraClass || '') + '"><span>' + esc(label) + '</span>' + control + '</label>';
}

function saveCase(id) {
  var f = $('caseForm');
  if (!f || !f.reportValidity()) return;
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
      '<input id="personName" name="nom" placeholder="Nom / prenom" required>' +
      '<select id="personType" name="type" onchange="togglePersonFields()">' + options(PERSON_TYPES, 'Suspect') + '</select>' +
      '<div id="investigatorField" class="full hidden"><select id="investigatorSelect" name="discord_id" onchange="fillInvestigatorFromSelect()"><option value="">Chargement des enqueteurs CID...</option></select></div>' +
      '<input name="tel" placeholder="555-1234">' +
      '<textarea class="full" name="commentaires" rows="4" placeholder="Commentaires CID"></textarea>' +
    '</div></form>',
    '<button type="button" class="btn btn-ghost" onclick="closeModal()">Annuler</button><button type="button" class="btn btn-gold" onclick="' + callAttr('savePerson', caseId) + '">Ajouter</button>'
  );
  togglePersonFields();
}
async function loadDiscordRoleMembers(roleId) {
  if (DISCORD_ROLE_MEMBER_CACHE[roleId]) return DISCORD_ROLE_MEMBER_CACHE[roleId];
  var res = await fetch(workerUrl('/discord/agents-roster', { guild_id: GUILD_ID, role_ids: roleId, limit: 1000 }));
  if (!res.ok) throw new Error('Roster Discord indisponible.');
  var data = await res.json();
  DISCORD_ROLE_MEMBER_CACHE[roleId] = data.agents || [];
  return DISCORD_ROLE_MEMBER_CACHE[roleId];
}
async function togglePersonFields() {
  var type = $('personType') && $('personType').value;
  var wrap = $('investigatorField');
  var select = $('investigatorSelect');
  if (!wrap || !select) return;
  wrap.classList.toggle('hidden', type !== 'Enqueteur');
  if (type !== 'Enqueteur' || select.dataset.loaded === '1') return;
  select.innerHTML = '<option value="">Chargement des enqueteurs CID...</option>';
  try {
    var agents = await loadDiscordRoleMembers(CID_INVESTIGATOR_ROLE_ID);
    select.dataset.loaded = '1';
    select.innerHTML = '<option value="">Selectionner un enqueteur CID</option>' + agents.map(function(a) {
      var label = (a.matricule ? '[' + a.matricule + '] ' : '') + a.prenom + ' ' + a.nom + (a.grade ? ' - ' + a.grade : '');
      return '<option value="' + esc(a.discord_id) + '" data-name="' + esc(a.prenom + ' ' + a.nom) + '">' + esc(label) + '</option>';
    }).join('');
  } catch (e) {
    select.innerHTML = '<option value="">Impossible de charger la liste Discord</option>';
  }
}
function fillInvestigatorFromSelect() {
  var select = $('investigatorSelect');
  var option = select && select.options[select.selectedIndex];
  if (option && option.dataset.name && $('personName')) $('personName').value = option.dataset.name;
}
function savePerson(caseId) {
  var c = caseGet(caseId);
  var form = $('personForm');
  if (!form || !form.reportValidity()) return;
  var fd = new FormData($('personForm'));
  var p = { id: uid('person'), nom: fd.get('nom'), type: fd.get('type'), tel: fd.get('tel') || '', discord_id: fd.get('discord_id') || '', commentaires: fd.get('commentaires') || '', fichiers: [] };
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
  openConfirmModal('Supprimer la personne', 'Cette personne sera retiree du dossier CID. Les informations liees a cette fiche ne seront plus visibles.', 'danger', callAttr('confirmDeletePerson', caseId, pid));
}
function confirmDeletePerson(caseId, pid) {
  var c = caseGet(caseId);
  c.personnes = (c.personnes || []).filter(function(p) { return p.id !== pid; });
  caseUpsert(c);
  STATE.route = { page: 'dossiers', id: caseId };
  closeModal();
  renderApp();
}

function openEvidenceModal(caseId) {
  var c = caseGet(caseId);
  var suspects = '<option value="">Non attribue</option>' + (c.personnes || []).filter(function(p) { return p.type === 'Suspect'; }).map(function(p) { return '<option value="' + esc(p.id) + '">' + esc(p.nom) + '</option>'; }).join('');
  openModal('Ajouter une preuve',
    '<form id="evidenceForm"><div class="form-grid">' +
      '<select name="type" id="evidenceType" onchange="toggleEvidenceFields()">' + options(managedOptions('types_preuves'), 'Photo') + '</select>' +
      '<div id="fileField"><input name="fichier" type="file" accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.txt"></div>' +
      '<div id="weaponFields" class="form-grid full hidden"><input name="type_arme" placeholder="Type d\'arme"><input name="numero_serie" placeholder="Numero de serie"><select name="suspect_arme">' + suspects + '</select></div>' +
      '<div id="drugFields" class="form-grid full hidden"><input name="type_drogue" placeholder="Type de drogue"><input name="quantite" placeholder="Quantite"><select name="suspect_drogue">' + suspects + '</select></div>' +
      '<div id="vehicleFields" class="form-grid full hidden"><input name="modele" placeholder="Modele du vehicule"><input name="plaque" placeholder="Plaque"><select name="suspect_vehicule">' + suspects + '</select></div>' +
      '<textarea class="full" name="description" rows="4" placeholder="Description / contexte"></textarea>' +
      '<div id="evidenceError" class="form-error full"></div>' +
    '</div></form>',
    '<button type="button" class="btn btn-ghost" onclick="closeModal()">Annuler</button><button type="button" class="btn btn-gold" onclick="' + callAttr('saveEvidence', caseId) + '">Ajouter</button>'
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
function setModalError(id, message) {
  var box = $(id);
  if (!box) {
    if ($('modalRoot')) openInfoModal('Erreur', message);
    return;
  }
  box.textContent = message || '';
  box.classList.toggle('show', !!message);
}
function dataUrlBytes(dataUrl) {
  var comma = String(dataUrl || '').indexOf(',');
  var data = comma === -1 ? String(dataUrl || '') : String(dataUrl || '').slice(comma + 1);
  return Math.ceil(data.length * 3 / 4);
}
function compressImageFile(file) {
  return new Promise(function(resolve, reject) {
    var reader = new FileReader();
    reader.onerror = function() { reject(new Error('Lecture image impossible.')); };
    reader.onload = function() {
      var img = new Image();
      img.onerror = function() { reject(new Error('Image illisible.')); };
      img.onload = function() {
        var maxSide = 1600;
        var ratio = Math.min(1, maxSide / Math.max(img.width, img.height));
        var canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.width * ratio));
        canvas.height = Math.max(1, Math.round(img.height * ratio));
        var ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        var data = canvas.toDataURL('image/jpeg', 0.76);
        resolve({ name: file.name.replace(/\.[^.]+$/, '') + '.jpg', type: 'image/jpeg', data: data });
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}
async function readFile(input) {
  var file = input && input.files && input.files[0];
  if (!file) return null;
  if (String(file.type || '').indexOf('image/') === 0) {
    var compressed = await compressImageFile(file);
    if (dataUrlBytes(compressed.data) > MAX_ATTACHMENT_BYTES) {
      throw new Error('Image trop lourde meme apres compression. Prends une capture plus petite.');
    }
    return compressed;
  }
  return new Promise(function(resolve, reject) {
    var r = new FileReader();
    r.onload = function() {
      if (dataUrlBytes(r.result) > MAX_ATTACHMENT_BYTES) {
        reject(new Error('Fichier trop lourd pour cette sauvegarde. Utilise une image compressee ou un fichier plus leger.'));
        return;
      }
      resolve({ name: file.name, type: file.type, data: r.result });
    };
    r.onerror = function() { reject(new Error('Lecture fichier impossible.')); };
    r.readAsDataURL(file);
  });
}
async function saveEvidence(caseId) {
  try {
    setModalError('evidenceError', '');
    var c = caseGet(caseId);
    if (!c) throw new Error('Dossier introuvable.');
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
  } catch (e) {
    setModalError('evidenceError', e && e.name === 'QuotaExceededError' ? 'Stockage navigateur plein. Supprime quelques grosses preuves ou utilise une image plus legere.' : (e.message || 'Impossible d ajouter la preuve.'));
  }
}

function openNoteModal(caseId) {
  openModal('Ajouter une note', '<form id="noteForm"><textarea name="note" rows="6" placeholder="Note CID..." required></textarea></form>', '<button type="button" class="btn btn-ghost" onclick="closeModal()">Annuler</button><button type="button" class="btn btn-gold" onclick="' + callAttr('saveNote', caseId) + '">Ajouter</button>');
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
  openModal('Ajouter un fichier personne', '<form id="personFileForm"><div class="form-grid"><select name="type">' + options(['Photo','Video','Audio','Document','Autre'], 'Photo') + '</select><input name="fichier" type="file" accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.txt" required><textarea class="full" name="note" rows="3" placeholder="Note"></textarea><div id="personFileError" class="form-error full"></div></div></form>', '<button type="button" class="btn btn-ghost" onclick="closeModal()">Annuler</button><button type="button" class="btn btn-gold" onclick="' + callAttr('savePersonFile', caseId, pid) + '">Ajouter</button>');
}
async function savePersonFile(caseId, pid) {
  try {
    setModalError('personFileError', '');
    var c = caseGet(caseId);
    if (!c) throw new Error('Dossier introuvable.');
    var p = c.personnes.find(function(x) { return x.id === pid; });
    if (!p) throw new Error('Personne introuvable.');
    var f = $('personFileForm');
    var fd = new FormData(f);
    var attachment = await readFile(f.querySelector('input[type=file]'));
    p.fichiers = p.fichiers || [];
    p.fichiers.push({ id: uid('file'), type: fd.get('type'), note: fd.get('note') || '', attachment: attachment, date: nowLabel() });
    caseUpsert(c);
    closeModal();
    renderApp();
  } catch (e) {
    setModalError('personFileError', e && e.name === 'QuotaExceededError' ? 'Stockage navigateur plein. Supprime quelques gros fichiers ou utilise une image plus legere.' : (e.message || 'Impossible d ajouter le fichier.'));
  }
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
  openConfirmModal('Archiver le dossier', 'Le dossier passera dans les archives CID. Il restera consultable depuis la page Archives.', 'warning', callAttr('confirmArchiveCase', id));
}
function confirmArchiveCase(id) {
  var c = caseGet(id);
  if (!c) return;
  c.statut = 'Classe';
  caseUpsert(c);
  closeModal();
  renderApp();
}
function deleteCase(id) {
  if (!canDeleteCases()) {
    openInfoModal('Acces refuse', 'Seul le role autorise ou les administrateurs peuvent supprimer un dossier CID.');
    return;
  }
  openConfirmModal('Supprimer le dossier', 'Cette action est definitive. Le dossier CID, ses personnes, notes et preuves locales seront supprimes.', 'danger', callAttr('confirmDeleteCase', id));
}
function confirmDeleteCase(id) {
  casesSave(casesLoad().filter(function(c) { return c.id !== id; }));
  STATE.route = { page: 'dossiers' };
  closeModal();
  renderApp();
}

boot();

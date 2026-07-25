var WORKER_BASE = 'https://sasp-intranet-bot.louisleurin.workers.dev';
var CID_STORE_KEY = 'sasp_cid_cases_v2';
var CID_DEMO_SEEDED_KEY = 'sasp_cid_demo_seeded_v1';
var MAX_ATTACHMENT_BYTES = 1800000;
var EFFECTIVE_CID_ROLE_ID = window.CID_ROLE_ID || '1518631634524569641';
var CID_INVESTIGATOR_ROLE_ID = '1518631634524569641';
var CID_DELETE_ROLE_ID = '1501526499910746132';
var DISCORD_ROLE_MEMBER_CACHE = {};

var STATE = {
  user: null,
  roles: [],
  discordId: '',
  displayName: '',
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
var CHARGES_CATALOG = [
  { nom: 'Braquage a main armee', amende: 25000, prison: 45 },
  { nom: 'Possession illegale d une arme', amende: 12000, prison: 25 },
  { nom: 'Refus d obtemperer', amende: 8000, prison: 15 },
  { nom: 'Association de malfaiteurs', amende: 15000, prison: 30 },
  { nom: 'Tentative de meurtre', amende: 35000, prison: 70 },
  { nom: 'Prise d otage', amende: 30000, prison: 65 },
  { nom: 'Trafic de stupefiants', amende: 22000, prison: 40 },
  { nom: 'Entrave a enquete', amende: 7000, prison: 10 }
];
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
  STATE.discordId = '';
  STATE.displayName = '';
  renderLogin();
}

function workerUrl(path, params) {
  var q = new URLSearchParams(params || {});
  if (typeof SITE_KEY !== 'undefined') q.set('site', SITE_KEY);
  return WORKER_BASE + path + (q.toString() ? '?' + q.toString() : '');
}

async function loadDiscordRoles(user) {
  var discordId = getDiscordId(user);
  if (!discordId) return [];
  var res = await fetch(workerUrl('/auth/check-roles', { user_id: discordId }));
  if (!res.ok) return [];
  var data = await res.json();
  return data.roles || [];
}
function getDiscordId(user) {
  var identity = user && user.identities && user.identities.find(function(i) { return i.provider === 'discord'; });
  return identity && identity.identity_data && (identity.identity_data.provider_id || identity.identity_data.sub) || '';
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
    STATE.discordId = getDiscordId(session.user);
    STATE.roles = await loadDiscordRoles(session.user);
    if (!hasAccess()) return renderLogin('Acces refuse: role CID requis.');
    STATE.displayName = await resolveServerDisplayName();
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
  try {
    var list = JSON.parse(localStorage.getItem(CID_STORE_KEY) || '[]');
    if (!localStorage.getItem(CID_DEMO_SEEDED_KEY) && !list.some(function(c) { return c.id === 'cid_demo_complete'; })) {
      list.unshift(exampleCase(list));
      casesSave(list);
      localStorage.setItem(CID_DEMO_SEEDED_KEY, '1');
    }
    return list;
  }
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

function exampleCase(list) {
  var suspect1 = 'demo_p_suspect_1';
  var suspect2 = 'demo_p_suspect_2';
  var victim = 'demo_p_victim_1';
  var witness = 'demo_p_witness_1';
  var investigator = 'demo_p_investigator_1';
  var opened = '2026-07-22 18:25';
  return {
    id: 'cid_demo_complete',
    numero: nextNumber(list || []),
    titre: '[EXEMPLE] Braquage organise - Fleeca Vinewood',
    statut: 'Ouvert',
    priorite: 'Critique',
    classification: 'Braquage',
    confidentialite: 'CID uniquement',
    responsable: displayName(),
    resume: 'Groupe arme suspecte dans un braquage coordonne sur Fleeca Vinewood. Deux suspects identifies, un vehicule signale, plusieurs scelles a exploiter.',
    description: 'Le 22/07/2026 vers 18h10, plusieurs unites SASP signalent une prise d otage suivie d un braquage. Les suspects auraient utilise un Sultan RS noir immatricule 8QX-441. Une arme de poing, des douilles, un telephone et une petite quantite de stupefiants ont ete saisis apres une poursuite terminee pres de Rockford Hills. Le dossier sert d exemple complet pour tester les fiches personnes, preuves, notes, filtres et recherche globale.',
    date_ouverture: opened,
    updated_at: opened,
    personnes: [
      { id: suspect1, nom: 'Marcus Velasquez', type: 'Suspect', tel: '555-1842', rapport_mdt: '#MDT-8842', rapport_event_url: 'https://discord.com/channels/1500975724750704661/1518674483060281454/1529900011111111111', commentaires: 'Conducteur presume. Porte une veste noire, tatouage cou droit. A relier au vehicule Sultan RS.', fichiers: [] },
      { id: suspect2, nom: 'Darnell Johnson', type: 'Suspect', tel: '555-5591', rapport_mdt: '#MDT-8843', rapport_event_url: 'https://discord.com/channels/1500975724750704661/1518674483060281454/1529900022222222222', commentaires: 'Suspect arme vu cote coffre. Possiblement en lien avec une saisie Glock.', fichiers: [] },
      { id: victim, nom: 'Lena Brooks', type: 'Victime', tel: '555-7204', rapport_mdt: '#MDT-8842', rapport_event_url: '', commentaires: 'Employee Fleeca. Declare avoir ete maintenue sous menace pendant environ 12 minutes.', fichiers: [] },
      { id: witness, nom: 'Evan Carter', type: 'Temoin', tel: '555-3380', rapport_mdt: '#MDT-8842', rapport_event_url: '', commentaires: 'Temoin civil. A vu le Sultan RS quitter la zone par l est.', fichiers: [] },
      { id: investigator, nom: displayName(), type: 'Enqueteur', tel: '555-0000', rapport_mdt: '#MDT-8842', rapport_event_url: '', commentaires: 'Responsable CID du dossier exemple.', fichiers: [] }
    ],
    preuves: [
      { id: 'demo_e_weapon', scelle: 'SC-2026-0001', type: 'Arme', description: 'Arme recuperee apres interpellation.', details: { type_arme: 'Glock 19', numero_serie: 'G19-VWD-7742', suspect_id: suspect2 }, attachment: null, date: '2026-07-22 18:31' },
      { id: 'demo_e_shell', scelle: 'SC-2026-0002', type: 'Douille', description: 'Deux douilles retrouvees derriere le comptoir.', details: {}, attachment: null, date: '2026-07-22 18:34' },
      { id: 'demo_e_drug', scelle: 'SC-2026-0003', type: 'Drogue', description: 'Sachet trouve dans le vehicule.', details: { type_drogue: 'Cocaine', quantite: '14 pochons', suspect_id: suspect1 }, attachment: null, date: '2026-07-22 18:39' },
      { id: 'demo_e_vehicle', scelle: 'SC-2026-0004', type: 'Vehicule', description: 'Vehicule utilise pour la fuite.', details: { modele: 'Sultan RS noir', plaque: '8QX-441', suspect_id: suspect1 }, attachment: null, date: '2026-07-22 18:45' },
      { id: 'demo_e_phone', scelle: 'SC-2026-0005', type: 'Telephone', description: 'Telephone saisi sur Darnell Johnson. Extraction a demander.', details: {}, attachment: null, date: '2026-07-22 18:48' },
      { id: 'demo_e_doc', scelle: 'SC-2026-0006', type: 'Document', description: 'Rapport d intervention SASP ajoute au dossier.', details: {}, attachment: null, date: '2026-07-22 18:52' }
    ],
    journal: [
      { date: '2026-07-22 19:05', texte: 'A confirmer : exploitation telephone et verification plaque 8QX-441.', type: 'note' },
      { date: '2026-07-22 18:58', texte: 'Priorite critique maintenue, suspects potentiellement lies a une serie de braquages.', type: 'note' },
      { date: '2026-07-22 18:40', texte: 'Demander comparaison balistique sur Glock 19 et douilles SC-2026-0002.', type: 'note' },
      { date: '2026-07-22 18:25', texte: 'Dossier exemple cree pour presentation CID.', type: 'system' }
    ]
  };
}

function renderApp() {
  var userName = displayName();
  $('app').innerHTML = [
    '<div class="app-shell">',
      '<aside class="sidebar">',
        '<div class="brand"><img src="assets/cid-logo.png" alt="CID"><div><strong>SASP CID</strong><span>Criminal Investigation</span></div></div>',
        '<div class="profile-block"><span>Administrateur</span><strong>' + esc(userName) + '</strong><em>Acces CID</em></div>',
        '<div class="sidebar-foot"><strong>Discord</strong><br>Connecte et autorise</div>',
        '<nav class="nav">',
          '<div class="nav-title">Menu principal</div>',
          navButton('dashboard', 'Accueil', 'âŒ‚'),
          navButton('guide', 'Guide CID', '§'),
          '<div class="nav-group"><span>CID</span></div>',
          navButton('dossiers', 'Dossiers', 'â–£'),
          navButton('personnes', 'Personnes', 'â™™'),
          navButton('preuves', 'Preuves', 'â—†'),
          navButton('gestion', 'Gestion', 'âš™'),
          '<div class="nav-group"><span>Historique</span></div>',
          navButton('archives', 'Archives', 'â–¤'),
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
    var people = (c.personnes || []).map(function(p) { return [p.nom, p.tel, p.type, p.rapport_mdt, p.rapport_event_url, personReports(p, c).map(reportSearchText).join(' ')].join(' '); }).join(' ');
    var proofs = (c.preuves || []).map(function(e) { return [e.scelle, e.type, e.description, proofDetailsText(c, e)].join(' '); }).join(' ');
    return [c.numero, c.titre, c.statut, c.priorite, c.classification, c.resume, people, proofs].join(' ').toLowerCase().indexOf(q) !== -1;
  }).sort(function(a, b) { return String(b.updated_at || '').localeCompare(String(a.updated_at || '')); });
}

function renderContent() {
  if (STATE.route.page === 'search') return renderSearchResults();
  if (STATE.route.page === 'dashboard') return renderDashboard();
  if (STATE.route.page === 'guide') return renderGuide();
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
      var dossierFields = [c.numero, c.titre, c.statut, c.priorite, c.classification, c.confidentialite, c.resume, c.description, c.responsable];
      var peopleFields = (c.personnes || []).map(function(p) {
        return [p.nom, p.alias, p.type, p.tel, p.discord_id, p.commentaires, personReports(p, c).map(reportSearchText).join(' ')].join(' ');
      });
      var proofFields = (c.preuves || []).map(function(e) {
        return [e.scelle, e.type, e.description, proofDetailsText(c, e), e.attachment && e.attachment.name].join(' ');
      });
      var noteFields = (c.journal || []).filter(function(j) { return j.type === 'note'; }).map(function(j) {
        return [j.date, j.texte].join(' ');
      });
      if (matchText(dossierFields.concat(peopleFields, proofFields, noteFields).join(' '), q)) {
        var linkedCounts = [];
        var peopleHits = peopleFields.filter(function(v) { return matchText(v, q); }).length;
        var proofHits = proofFields.filter(function(v) { return matchText(v, q); }).length;
        var noteHits = noteFields.filter(function(v) { return matchText(v, q); }).length;
        if (peopleHits) linkedCounts.push(peopleHits + ' personne' + (peopleHits > 1 ? 's' : ''));
        if (proofHits) linkedCounts.push(proofHits + ' preuve' + (proofHits > 1 ? 's' : ''));
        if (noteHits) linkedCounts.push(noteHits + ' note' + (noteHits > 1 ? 's' : ''));
        results.push({
          type: 'Dossier',
          title: (c.numero || '-') + ' - ' + (c.titre || 'Dossier sans titre'),
          meta: matchText(dossierFields.join(' '), q)
            ? searchContext([c.resume, c.description, c.statut, c.priorite, c.classification, c.confidentialite, c.responsable], q)
            : 'Contient : ' + (linkedCounts.join(', ') || 'resultat lie'),
          action: callAttr('openSearchResult', 'dossiers', { id: c.id })
        });
      }
      (c.personnes || []).forEach(function(p) {
        if (matchText([p.nom, p.alias, p.type, p.tel, p.discord_id, p.commentaires].join(' '), q)) {
          results.push({ type: 'Personne', title: p.nom || 'Personne sans nom', meta: (c.numero || '-') + ' - ' + searchContext([p.alias, p.type, p.tel, p.commentaires], q), action: callAttr('openSearchResult', 'dossiers', { id: c.id, person: p.id }) });
        }
        personReports(p, c).forEach(function(r) {
          if (matchText(reportSearchText(r), q)) {
            results.push({ type: 'Rapport MDT', title: (r.numero || 'MDT') + ' - ' + (r.titre || 'Rapport lie'), meta: (c.numero || '-') + ' - ' + (p.nom || '-') + ' - ' + searchContext([r.type, r.statut, r.agent, r.agents_impliques, r.charges_text, r.resume], q), action: callAttr('openSearchResult', 'dossiers', { id: c.id, report: r.id, person: p.id }) });
          }
        });
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

function renderGuide() {
  $('content').innerHTML = [
    '<section class="guide-hero panel section">',
      '<div>',
        '<div class="kicker">Guide CID</div>',
        '<h1>Manuel complet pour agents debutants</h1>',
        '<p class="text">Ce guide explique comment utiliser le MDT CID : creation de dossiers, personnes liees, preuves, notes, recherche, archives et gestion des listes.</p>',
      '</div>',
      '<div class="guide-quick">',
        '<button class="btn btn-gold" onclick="' + callAttr('go', 'dossiers') + '">Ouvrir les dossiers</button>',
        '<button class="btn btn-ghost" onclick="' + callAttr('go', 'personnes') + '">Voir les personnes</button>',
        '<button class="btn btn-ghost" onclick="' + callAttr('go', 'preuves') + '">Voir les preuves</button>',
      '</div>',
    '</section>',
    '<section class="guide-grid">',
      guideCard('01', 'Role du site CID', [
        'Centraliser les enquetes CID dans un espace separe de l intranet SASP.',
        'Regrouper dossiers, suspects, victimes, temoins, enqueteurs, preuves, photos, documents et notes.',
        'Eviter les infos perdues dans Discord en gardant une fiche claire par affaire.'
      ]),
      guideCard('02', 'Creer un dossier', [
        'Va dans Dossiers puis Nouveau dossier.',
        'Renseigne au minimum le titre, le statut, la priorite, la classification, la confidentialite et le responsable.',
        'Ajoute un resume court pour comprendre l affaire rapidement.',
        'Le dossier apparait ensuite dans la liste et peut etre ouvert/modifie.'
      ]),
      guideCard('03', 'Statuts', [
        'Ouvert : enquete active.',
        'En attente : besoin d une info, d une validation ou d un retour.',
        'Ferme / Classe : affaire terminee.',
        'Archive : dossier retire de la vue principale mais conserve.'
      ]),
      guideCard('04', 'Priorites', [
        'Faible : suivi simple.',
        'Normale : dossier standard.',
        'Haute : a traiter rapidement.',
        'Critique : affaire sensible ou urgente.'
      ]),
      guideCard('05', 'Personnes liees', [
        'Ajoute toutes les personnes importantes : suspect, victime, temoin, informateur ou enqueteur.',
        'Pour un enqueteur, choisis un agent CID dans la liste quand elle est disponible.',
        'Utilise le telephone au format serveur : 555-1234.',
        'Tu peux ouvrir une fiche personne pour ajouter infos, photos, fichiers, rapport MDT et lien de rapport evenement.'
      ]),
      guideCard('06', 'Fiche personne', [
        'Clique sur une personne pour ouvrir sa fiche dediee.',
        'Ajoute photos, documents ou notes utiles a son identification.',
        'Renseigne le rapport MDT # si la personne est liee a un rapport in-game.',
        'Ajoute le lien du rapport evenement Discord si l info vient d un post/forum.'
      ]),
      guideCard('07', 'Preuves', [
        'Ajoute une preuve depuis un dossier avec le menu Ajout.',
        'Choisis le bon type : photo, document, ADN, douille, empreinte, arme, drogue, vehicule, objet, telephone, temoignage ou autre.',
        'Pour une arme : indique le type d arme et le numero de serie.',
        'Pour un vehicule : indique le modele, la plaque et le suspect lie si besoin.'
      ]),
      guideCard('08', 'Fichiers et images', [
        'Le bouton fichier apparait seulement quand le type le necessite : photo, document, ADN, douille ou empreinte.',
        'Une image ajoutee dans une preuve peut etre ouverte pour verification.',
        'Si une mauvaise image est ajoutee, elle peut etre supprimee depuis la preuve.'
      ]),
      guideCard('09', 'Notes', [
        'Les notes servent aux informations internes CID : pistes, hypotheses, consignes, suivi.',
        'Elles doivent rester courtes et exploitables.',
        'Une note peut etre modifiee apres creation.',
        'Evite de melanger notes et historique automatique.'
      ]),
      guideCard('10', 'Recherche globale', [
        'La barre en haut fonctionne comme un CTRL+F du site.',
        'Elle cherche dans les dossiers, personnes, preuves, fichiers et notes.',
        'Si un nom apparait dans une preuve ou une personne, le dossier parent apparait aussi dans les resultats.',
        'Clique sur un resultat pour ouvrir directement le dossier concerne.'
      ]),
      guideCard('11', 'Archives et suppression', [
        'Archive un dossier quand il doit etre conserve mais retire de la vue active.',
        'Supprime uniquement en cas d erreur ou doublon.',
        'La suppression est protegee par confirmation et reservee au role autorise + admins.',
        'Si tu hesites, archive plutot que supprimer.'
      ]),
      guideCard('12', 'Gestion', [
        'La page Gestion permet aux responsables de modifier les listes du site.',
        'On peut ajouter ou retirer priorites, classifications, confidentialites et types de preuves.',
        'Les changements s appliquent aux nouveaux dossiers et prochaines modifications.',
        'Ne change pas une liste sans validation CID/Command Staff.'
      ]),
    '</section>',
    '<section class="panel section guide-flow">',
      '<div class="kicker">Workflow conseille</div>',
      '<h2>Ordre simple pour traiter une enquete</h2>',
      '<div class="flow-row">',
        flowStep('1', 'Creer dossier', 'Titre clair, statut, priorite, confidentialite.'),
        flowStep('2', 'Ajouter personnes', 'Suspects, victimes, temoins, enqueteurs.'),
        flowStep('3', 'Ajouter preuves', 'Photos, armes, drogues, vehicules, documents.'),
        flowStep('4', 'Noter le suivi', 'Ajoute les infos utiles en notes CID.'),
        flowStep('5', 'Archiver', 'Quand l affaire est terminee ou classee.'),
      '</div>',
    '</section>',
    '<section class="panel section guide-rules">',
      '<div class="kicker">Regles rapides</div>',
      '<h2>A retenir</h2>',
      '<ul>',
        '<li>Ne cree pas deux dossiers pour la meme affaire.</li>',
        '<li>Utilise des titres courts et lisibles.</li>',
        '<li>Une preuve doit toujours avoir une description utile.</li>',
        '<li>Un suspect important doit avoir une fiche personne propre.</li>',
        '<li>Archive au lieu de supprimer si le dossier doit etre conserve.</li>',
      '</ul>',
    '</section>'
  ].join('');
}

function guideCard(num, title, lines) {
  return [
    '<article class="guide-card panel section">',
      '<div class="guide-num">' + esc(num) + '</div>',
      '<h2>' + esc(title) + '</h2>',
      '<ul>' + lines.map(function(line) { return '<li>' + esc(line) + '</li>'; }).join('') + '</ul>',
    '</article>'
  ].join('');
}

function flowStep(num, title, text) {
  return '<div class="flow-step"><strong>' + esc(num) + '</strong><span>' + esc(title) + '</span><p>' + esc(text) + '</p></div>';
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
    return '<button class="mini-row" onclick="' + callAttr('go', 'dossiers', { id: c.id }) + '"><span>' + esc(c.numero) + '</span><strong>' + caseTitleHtml(c) + '</strong>' + statusBadge(c.statut) + '</button>';
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
      '<div class="case-name">' + caseTitleHtml(c) + '</div>',
      '<div class="case-meta"><span>' + esc(c.responsable || 'CID') + '</span><span>' + esc(c.updated_at || '-') + '</span></div>',
    '</article>'
  ].join('');
}

function renderWorkspace(c) {
  if (!c) return '<div class="empty"><div><h2>Aucun dossier selectionne</h2><p>Selectionne ou cree un dossier CID.</p></div></div>';
  if (STATE.route.report) return renderMdtReportWorkspace(c, STATE.route.report);
  if (STATE.route.person) return renderPersonWorkspace(c, STATE.route.person);
  var people = c.personnes || [];
  var proofs = c.preuves || [];
  var notes = (c.journal || []).map(function(j, i) { return Object.assign({ _index: i }, j); }).filter(function(j) { return j.type === 'note'; });
  var activeTab = STATE.route.tab || 'overview';
  return [
    '<div class="workspace cid-case-workspace">',
      caseSystemBar(),
      caseBreadcrumb(c),
      caseHero(c, people, proofs),
      caseTabs(c, activeTab),
      renderCaseTabContent(c, activeTab, people, proofs, notes),
    '</div>'
  ].join('');
}

function caseSystemBar() {
  return [
    '<div class="cid-system-strip">',
      '<span><strong>CID MDT</strong> v3.2.8</span>',
      '<span>Terminal : CID-SUD-04</span>',
      '<span>Utilisateur : ' + esc(displayName()) + '</span>',
      '<span class="sys-secure">Connexion securisee</span>',
      '<span>Derniere synchronisation : il y a 12 sec</span>',
    '</div>'
  ].join('');
}
function caseBreadcrumb(c) {
  return '<div class="cid-breadcrumb"><button onclick="' + callAttr('go', 'dashboard') + '">Accueil</button><span>&gt;</span><button onclick="' + callAttr('go', 'dossiers') + '">Enquetes</button><span>&gt;</span><button onclick="' + callAttr('go', 'dossiers', { id: c.id }) + '">' + esc(c.numero) + '</button><span>&gt;</span><strong>' + caseTitleHtml(c) + '</strong></div>';
}
function caseHero(c, people, proofs) {
  return [
    '<div class="cid-case-hero">',
      '<div class="cid-hero-copy">',
        '<div class="kicker">Dossier operationnel</div>',
        '<div class="cid-title-line"><h1>' + caseTitleHtml(c) + '</h1>' + priorityBadge(c.priorite) + statusBadge(c.statut) + '</div>',
        '<p>' + esc(c.resume || c.description || 'Aucun resume operationnel renseigne.') + '</p>',
        '<div class="cid-hero-meta"><span>Ouvert le ' + esc(c.date_ouverture || '-') + '</span><span>Derniere modif. ' + esc(c.updated_at || '-') + '</span><span>Responsable : ' + esc(caseLead(c)) + '</span></div>',
      '</div>',
      '<div class="case-command-bar cid-command-bar">' +
        commandButton('&#9998;', 'Modifier', 'neutral', callAttr('openCaseModal', c.id)) +
        addMenu(c) +
        '<span class="command-divider"></span>' +
        commandButton('&#9635;', 'Archiver', 'neutral', callAttr('archiveCase', c.id)) +
        (canDeleteCases() ? commandButton('&#10005;', 'Supprimer', 'danger', callAttr('deleteCase', c.id)) : '') +
      '</div>',
    '</div>',
    '<div class="cid-intel-cards">',
      intelCard('Suspects', countPeople(people, 'Suspect'), '&#9818;'),
      intelCard('Victimes', countPeople(people, 'Victime'), '&#9679;'),
      intelCard('Temoins', countPeople(people, 'Temoin'), '&#128065;'),
      intelCard('Preuves', proofs.length, '&#9635;'),
      intelCard('Temps ouvert', caseAge(c), '&#9201;'),
      intelCard('Rapports MDT', totalReports(people), '&#128196;'),
    '</div>'
  ].join('');
}
function intelCard(label, value, icon) {
  return '<article class="cid-intel-card"><i>' + icon + '</i><strong>' + esc(value) + '</strong><span>' + esc(label) + '</span></article>';
}
function caseTabs(c, active) {
  var tabs = [
    ['overview', 'Vue generale', ''],
    ['personnes', 'Personnes', (c.personnes || []).length],
    ['preuves', 'Preuves', (c.preuves || []).length],
    ['rapports', 'Rapports', ''],
    ['mandats', 'Mandats', ''],
    ['documents', 'Documents', ''],
    ['journal', 'Journal', '']
  ];
  return '<div class="cid-tabbar">' + tabs.map(function(t) {
    return '<button class="' + (active === t[0] ? 'active' : '') + '" onclick="' + callAttr('go', 'dossiers', { id: c.id, tab: t[0] }) + '"><span>' + esc(t[1]) + '</span>' + (t[2] !== '' ? '<em>' + esc(t[2]) + '</em>' : '') + '</button>';
  }).join('') + '</div>';
}
function renderCaseTabContent(c, activeTab, people, proofs, notes) {
  if (activeTab === 'personnes') return '<div class="cid-single-panel">' + casePeopleCards(c, people, true) + '</div>';
  if (activeTab === 'preuves') return '<div class="cid-single-panel">' + caseEvidenceGallery(c, proofs, true) + '<section class="panel section cid-table-panel">' + evidenceTable(c, proofs) + '</section></div>';
  if (activeTab === 'rapports') return '<div class="cid-single-panel">' + caseReportsPanel(c, true) + '</div>';
  if (activeTab === 'journal') return '<div class="cid-single-panel"><section class="panel section cid-notes-panel"><h2>Notes CID</h2><div class="note-list">' + (notes.length ? notes.map(function(n) { return noteHtml(c, n); }).join('') : '<div class="note-item">Aucune note.</div>') + '</div></section></div>';
  if (/mandats|documents/.test(activeTab)) return renderEmptyOperationalTab(activeTab);
  return [
    '<div class="cid-overview-grid">',
      caseIdentityPanel(c, people, proofs),
      casePeopleCards(c, people, false),
      caseEvidenceGallery(c, proofs, false),
      caseReportsPanel(c, false),
      '<section class="panel section cid-summary-panel"><h2>Resume operationnel</h2><p class="text">' + esc(c.description || c.resume || 'Aucun descriptif renseigne.') + '</p></section>',
      '<section class="panel section cid-notes-panel"><h2>Notes CID</h2><div class="note-list">' + (notes.length ? notes.map(function(n) { return noteHtml(c, n); }).join('') : '<div class="note-item">Aucune note.</div>') + '</div></section>',
    '</div>'
  ].join('');
}
function renderEmptyOperationalTab(tab) {
  var labels = { rapports: 'Rapports', mandats: 'Mandats', documents: 'Documents' };
  return '<section class="panel section cid-empty-tab"><div class="kicker">Module CID</div><h2>' + esc(labels[tab] || tab) + '</h2><p class="text">Aucun element specialise n est encore rattache a ce dossier. Les preuves, notes et personnes restent disponibles dans leurs onglets.</p></section>';
}
function caseIdentityPanel(c, people, proofs) {
  return [
    '<section class="panel section cid-identity-panel">',
      '<div class="panel-head-mini"><div><div class="kicker">Dossier</div><h2>Fiche identite</h2></div>' + badge('Confidentiel', 'gold') + '</div>',
      '<div class="case-id-grid">',
        identityRow('Numero', c.numero),
        identityRow('Cree le', c.date_ouverture),
        identityRow('Responsable', caseLead(c)),
        identityRow('Statut', statusBadge(c.statut), true),
        identityRow('Priorite', priorityBadge(c.priorite), true),
        identityRow('Classification', c.classification || '-'),
        identityRow('Procureur', c.procureur || 'Aucun'),
        identityRow('Juge', c.juge || 'Aucun'),
        identityRow('Date limite', caseDeadline(c)),
      '</div>',
    '</section>'
  ].join('');
}
function identityRow(label, value, raw) {
  return '<div class="identity-row"><span>' + esc(label) + '</span><strong>' + (raw ? value : esc(value || '-')) + '</strong></div>';
}
function casePeopleCards(c, people, full) {
  return '<section class="panel section cid-people-panel ' + (full ? 'full' : '') + '"><div class="panel-head-mini"><div><div class="kicker">Personnes</div><h2>Personnes liees</h2></div><button class="btn btn-ghost btn-small" onclick="' + callAttr('openPersonModal', c.id) + '">Ajouter</button></div>' + (people.length ? '<div class="person-card-list">' + people.map(function(p) { return personCard(c, p); }).join('') + '</div>' : '<div class="text">Aucune personne liee.</div>') + '</section>';
}
function personCard(c, p) {
  var danger = p.dangerosite || (/suspect/i.test(p.type || '') ? 'Elevee' : 'Normale');
  var reports = personReports(p, c);
  var seizures = linkedEvidenceForPerson(c, p, false).length;
  return [
    '<article class="person-card person-card-wide">',
      '<button class="person-card-open" onclick="' + callAttr('go', 'dossiers', { id: c.id, person: p.id }) + '">' + personAvatar(p, 'card') + '</button>',
      '<div class="person-card-body">',
        '<div class="person-card-title"><div><strong>' + esc(p.nom || 'Inconnu') + '</strong><span>' + esc(p.alias ? p.alias : p.type || 'Personne liee') + '</span></div>' + badge(p.type || 'Personne', /suspect/i.test(p.type || '') ? 'red' : 'blue') + '</div>',
        '<div class="person-card-info">',
          '<span>Telephone : <strong>' + esc(p.tel || '-') + '</strong></span>',
          '<span>Dangerosite : <strong>' + esc(danger) + '</strong></span>',
          '<span>Statut : <strong>' + esc(p.statut_actuel || 'Actif') + '</strong></span>',
        '</div>',
        '<div class="person-card-counts"><span>' + reports.length + ' rapport(s) MDT lie(s)</span><span>' + seizures + ' saisie(s) / preuve(s) liee(s)</span></div>',
      '</div>',
      '<div class="person-card-actions">',
        '<button class="btn btn-ghost btn-small" onclick="' + callAttr('go', 'dossiers', { id: c.id, person: p.id }) + '">Fiche</button>',
        '<button class="btn btn-ghost btn-small" onclick="' + callAttr('openMdtReportModal', c.id, p.id) + '">Rapport</button>',
        '<button class="btn btn-gold btn-small" onclick="' + callAttr('openEvidenceModal', c.id) + '">Saisie</button>',
      '</div>',
    '</article>'
  ].join('');
}
function caseEvidenceGallery(c, proofs, full) {
  return '<section class="panel section cid-evidence-panel ' + (full ? 'full' : '') + '"><div class="panel-head-mini"><div><div class="kicker">Scelles</div><h2>Preuves et pieces</h2></div><button class="btn btn-gold btn-small" onclick="' + callAttr('openEvidenceModal', c.id) + '">Ajouter</button></div>' + (proofs.length ? '<div class="evidence-card-grid">' + proofs.map(function(e) { return evidenceCard(c, e); }).join('') + '</div>' : '<div class="text">Aucune preuve scellee.</div>') + '</section>';
}
function evidenceCard(c, e) {
  var icon = evidenceIcon(e.type);
  var thumb = e.attachment && e.attachment.data ? '<div onclick="event.stopPropagation()">' + attachmentHtml(e.attachment, functionName('previewEvidence', c.id, e.id)) + '</div>' : '<div class="evidence-icon">' + icon + '</div>';
  return '<article class="evidence-card" onclick="' + callAttr('openEvidenceModal', c.id, e.id) + '">' + thumb + '<div><strong>' + esc(e.scelle || 'SC') + '</strong><span>' + icon + ' ' + esc(e.type || 'Preuve') + '</span></div><p>' + esc(proofDetailsText(c, e) || e.description || 'Aucun detail') + '</p></article>';
}
function caseReportsPanel(c, full) {
  var rows = allCaseReports(c);
  return '<section class="panel section cid-reports-panel ' + (full ? 'full' : '') + '"><div class="panel-head-mini"><div><div class="kicker">Rapports MDT</div><h2>Rapports MDT lies</h2></div></div>' + (rows.length ? '<div class="case-report-grid">' + rows.map(function(row) { return caseReportCard(c, row.person, row.report); }).join('') + '</div>' : '<p class="text">Aucun rapport MDT lie a ce dossier.</p>') + '</section>';
}
function caseReportCard(c, p, r) {
  var title = r.titre || r.resume || 'Rapport MDT lie';
  return [
    '<article class="case-report-card">',
      '<div class="case-report-top"><strong>RAPPORT MDT #' + esc(reportNumber(r)) + '</strong>' + badge(r.statut || 'En cours', /clot|condam|classe/i.test(r.statut || '') ? 'green' : 'gold') + '</div>',
      '<h3>' + esc(title) + '</h3>',
      '<p>' + esc(r.resume || 'Aucun resume court renseigne.') + '</p>',
      '<div class="case-report-meta">',
        '<span>Personne liee : <button onclick="' + callAttr('go', 'dossiers', { id: c.id, person: p.id }) + '">' + esc(p.nom || '-') + '</button></span>',
        '<span>Agent : <strong>' + esc(r.agent || r.auteur || '-') + '</strong></span>',
        '<span>Type : <strong>' + esc(r.type || 'Rapport MDT') + '</strong></span>',
        '<span>Date : <strong>' + esc(r.date_rapport || r.date_arrestation || '-') + '</strong></span>',
      '</div>',
      '<div class="actions"><button class="btn btn-ghost btn-small" onclick="' + callAttr('go', 'dossiers', { id: c.id, report: r.id, person: p.id }) + '">Voir les details</button></div>',
    '</article>'
  ].join('');
}
function reportNumber(r) {
  return String(r.numero || 'MDT').replace(/^#?MDT-?/i, '').replace(/^#/, '');
}
function evidenceTypeBadge(type) {
  return '<span class="badge gold proof-type-badge"><span>' + evidenceIcon(type) + '</span>' + esc(type || 'Preuve') + '</span>';
}
function countPeople(people, type) { return people.filter(function(p) { return p.type === type; }).length; }
function totalReports(people) {
  return (people || []).reduce(function(sum, p) { return sum + personReports(p, null).length; }, 0);
}
function personReports(p, c) {
  var reports = (p && p.mdt_reports || []).slice();
  if (p && p.rapport_mdt && !reports.some(function(r) { return r.numero === p.rapport_mdt; })) {
    reports.unshift({
      id: 'legacy_' + String(p.rapport_mdt).replace(/\W+/g, '_'),
      numero: p.rapport_mdt,
      titre: 'Rapport MDT importe',
      type: 'Rapport MDT',
      date_rapport: '',
      date_arrestation: '',
      agent: '',
      agents_impliques: '',
      auteurs: '',
      dossier_cid: c && c.numero || '',
      lieu: '',
      statut: 'Archive',
      resume: p.commentaires || '',
      charges: [],
      amende: '',
      prison: '',
      saisies: '',
      preuves: '',
      decision: '',
      notes: 'Rapport importe depuis l ancien champ Rapport MDT.'
    });
  }
  return reports;
}
function allCaseReports(c) {
  var rows = [];
  (c.personnes || []).forEach(function(p) {
    personReports(p, c).forEach(function(r) {
      rows.push({ person: p, report: r });
    });
  });
  return rows;
}
function reportSearchText(r) {
  return [
    r.numero, r.titre, r.type, r.date_rapport || r.date_arrestation, r.agent, r.auteurs,
    r.agents_impliques, r.statut, r.charges_text, r.resume, r.decision, r.saisies, r.preuves
  ].join(' ');
}
function linkedEvidenceForPerson(c, p, vehiclesOnly) {
  return (c.preuves || []).filter(function(e) {
    var text = (e.description || '') + ' ' + proofDetailsText(c, e);
    var linked = e.details && e.details.suspect_id === p.id || text.toLowerCase().indexOf(String(p.nom || '').toLowerCase()) !== -1;
    return linked && (!vehiclesOnly || e.type === 'Vehicule');
  });
}
function personAvatar(p, size) {
  var cls = size === 'large' ? 'person-avatar large' : 'person-avatar';
  if (p && p.photo && p.photo.data) return '<img class="' + cls + '" src="' + p.photo.data + '" alt="">';
  return '<div class="' + cls + '">' + initials(p && p.nom) + '</div>';
}
function initials(name) {
  return String(name || 'CID').split(/\s+/).filter(Boolean).slice(0, 2).map(function(p) { return p.charAt(0).toUpperCase(); }).join('') || 'CID';
}
function caseLead(c) {
  var inv = (c.personnes || []).find(function(p) { return p.type === 'Enqueteur'; });
  return inv && inv.nom || c.responsable || displayName();
}
function caseProgress(c) {
  var score = 18;
  score += Math.min((c.personnes || []).length * 8, 30);
  score += Math.min((c.preuves || []).length * 7, 35);
  score += Math.min((c.journal || []).length * 3, 17);
  if (/ferme|classe/i.test(c.statut || '')) score = 100;
  return Math.max(12, Math.min(100, score));
}
function caseAge(c) {
  var start = new Date(String(c.date_ouverture || '').replace(' ', 'T'));
  if (isNaN(start.getTime())) return '-';
  var diff = Date.now() - start.getTime();
  var days = Math.max(0, Math.floor(diff / 86400000));
  if (days > 0) return days + ' j';
  var hours = Math.max(1, Math.floor(diff / 3600000));
  return hours + ' h';
}
function caseDeadline(c) {
  if (c.date_limite) return c.date_limite;
  var start = new Date(String(c.date_ouverture || '').replace(' ', 'T'));
  if (isNaN(start.getTime())) return 'A definir';
  start.setDate(start.getDate() + 2);
  return start.toISOString().slice(0, 10);
}
function evidenceIcon(type) {
  if (/drogue/i.test(type || '')) return '&#127807;';
  if (/telephone/i.test(type || '')) return '&#128241;';
  if (/document/i.test(type || '')) return '&#128195;';
  if (/arme/i.test(type || '')) return '&#128299;';
  if (/vehicule/i.test(type || '')) return '&#128663;';
  if (/photo/i.test(type || '')) return '&#128247;';
  if (/video/i.test(type || '')) return '&#127909;';
  if (/audio/i.test(type || '')) return '&#127908;';
  if (/argent/i.test(type || '')) return '&#128181;';
  if (/douille|munition/i.test(type || '')) return '&#128993;';
  if (/empreinte|adn/i.test(type || '')) return '&#128269;';
  if (/objet/i.test(type || '')) return '&#128230;';
  return '&#9635;';
}
function evidenceOptions(list, selected) {
  return list.map(function(v) {
    return '<option value="' + esc(v) + '"' + (v === selected ? ' selected' : '') + '>' + evidenceIcon(v) + ' ' + esc(v) + '</option>';
  }).join('');
}
function money(v) {
  var n = Number(v || 0);
  if (!n) return '0 $';
  return n.toLocaleString('fr-FR') + ' $';
}
function reportCharges(report) {
  return (report && report.charges || []).map(function(ch) {
    return typeof ch === 'string' ? { nom: ch, amende: '', prison: '' } : ch;
  });
}

function chip(label, value) { return '<div class="chip"><span>' + esc(label) + '</span><strong>' + value + '</strong></div>'; }
function commandButton(icon, label, tone, action) {
  return '<button type="button" class="command-btn ' + esc(tone || 'neutral') + '" onclick="' + action + '"><i aria-hidden="true">' + icon + '</i><span>' + esc(label) + '</span></button>';
}
function isExampleCase(c) {
  return !!c && (c.id === 'cid_demo_complete' || /^\[EXEMPLE\]/i.test(c.titre || ''));
}
function caseTitleHtml(c) {
  var title = c && c.titre || 'Dossier sans titre';
  var clean = title.replace(/^\[EXEMPLE\]\s*/i, '');
  return (isExampleCase(c) ? '<span class="example-label">EXEMPLE</span> ' : '') + esc(clean);
}
function addMenu(c) {
  return '<details class="add-menu"><summary class="command-btn gold"><i aria-hidden="true">&#43;</i><span>Ajout</span></summary><div class="add-menu-panel">' +
    commandButton('&#43;', 'Note', 'neutral', callAttr('openNoteModal', c.id)) +
    commandButton('&#9671;', 'Personne', 'blue', callAttr('openPersonModal', c.id)) +
    commandButton('&#9670;', 'Preuve', 'gold', callAttr('openEvidenceModal', c.id)) +
  '</div></details>';
}
function noteHtml(c, n) {
  return '<button type="button" class="note-item clickable-note" onclick="' + callAttr('openNoteModal', c.id, n._index) + '"><strong>' + esc(n.date || '-') + '</strong><span>' + esc(n.texte || '') + '</span></button>';
}
function peopleTable(c, people) {
  if (!people.length) return '<div class="text">Aucune personne liee.</div>';
  return '<table><tbody>' + people.map(function(p) {
    return '<tr class="clickable" onclick="' + callAttr('go', 'dossiers', { id: c.id, person: p.id }) + '"><td><strong>' + esc(p.nom) + '</strong></td><td>' + badge(p.type, 'blue') + '</td><td>' + esc(p.tel || '-') + '</td></tr>';
  }).join('') + '</tbody></table>';
}
function evidenceTable(c, proofs) {
  if (!proofs.length) return '<div class="text">Aucune preuve scellee.</div>';
  return '<table><thead><tr><th>Apercu</th><th>Scelle</th><th>Type</th><th>Infos</th></tr></thead><tbody>' + proofs.map(function(e) {
    return '<tr class="clickable" onclick="' + callAttr('openEvidenceModal', c.id, e.id) + '"><td onclick="event.stopPropagation()">' + attachmentHtml(e.attachment, functionName('previewEvidence', c.id, e.id)) + '</td><td>' + esc(e.scelle || '-') + '</td><td>' + evidenceTypeBadge(e.type) + '</td><td>' + esc(proofDetailsText(c, e) || e.description || '-') + '</td></tr>';
  }).join('') + '</tbody></table>';
}

function renderPersonWorkspace(c, pid) {
  var p = (c.personnes || []).find(function(x) { return x.id === pid; });
  if (!p) return renderWorkspace(c);
  var tab = STATE.route.personTab || 'general';
  var reports = personReports(p, c);
  return [
    '<div class="workspace person-page">',
      '<div class="person-profile-head">',
        '<div class="person-profile-main">',
          personAvatar(p, 'large'),
          '<div><button class="btn btn-ghost btn-small" onclick="' + callAttr('go', 'dossiers', { id: c.id }) + '">Retour au dossier</button><div class="case-id" style="margin-top:12px">' + esc(c.numero) + ' - Fiche personne</div><h1>' + esc(p.nom || 'Personne') + '</h1><div class="subline"><span>' + esc(p.type || '-') + '</span><span>' + esc(p.tel || '-') + '</span><span>Dangerosite : ' + esc(p.dangerosite || 'Inconnue') + '</span><span>' + reports.length + ' rapport(s) MDT</span></div></div>',
        '</div>',
        '<div class="actions"><button class="btn btn-gold btn-small" onclick="' + callAttr('openMdtReportModal', c.id, p.id) + '">Lier rapport MDT</button><button class="btn btn-ghost btn-small" onclick="' + callAttr('openPersonPhotoModal', c.id, p.id) + '">' + (p.photo ? 'Remplacer photo' : 'Ajouter photo') + '</button>' + (p.photo ? '<button class="btn btn-red btn-small" onclick="' + callAttr('deletePersonPhoto', c.id, p.id) + '">Supprimer photo</button>' : '') + '<button class="btn btn-ghost btn-small" onclick="' + callAttr('openPersonFileModal', c.id, p.id) + '">Ajouter fichier</button><button class="btn btn-red btn-small" onclick="' + callAttr('deletePerson', c.id, p.id) + '">Supprimer</button></div>',
      '</div>',
      personTabs(c, p, tab),
      personTabContent(c, p, tab),
    '</div>'
  ].join('');
}

function findCaseReport(c, reportId) {
  var found = null;
  (c.personnes || []).some(function(p) {
    return personReports(p, c).some(function(r) {
      if (r.id === reportId) {
        found = { person: p, report: r };
        return true;
      }
      return false;
    });
  });
  return found;
}

function renderMdtReportWorkspace(c, reportId) {
  var found = findCaseReport(c, reportId);
  if (!found) return renderWorkspace(c);
  var p = found.person;
  var r = found.report;
  var linked = linkedEvidenceForPerson(c, p, false);
  var weapons = linked.filter(function(e) { return e.type === 'Arme'; });
  var vehicles = linked.filter(function(e) { return e.type === 'Vehicule'; });
  var seizures = linked.filter(function(e) { return ['Arme','Vehicule'].indexOf(e.type) === -1; });
  var suspects = (c.personnes || []).filter(function(x) { return /suspect/i.test(x.type || ''); });
  var civilians = (c.personnes || []).filter(function(x) { return !/suspect|enqueteur/i.test(x.type || ''); });
  var charges = r.charges_text || reportCharges(r).map(function(ch) { return ch.nom || ch; }).join('\n');
  return [
    '<div class="workspace report-workspace">',
      '<button class="btn btn-ghost btn-small" onclick="' + callAttr('go', 'dossiers', { id: c.id }) + '">Retour au dossier</button>',
      '<div class="report-detail-head">',
        '<div><div class="case-id">Rapport MDT lie</div><h1>' + esc(r.numero || 'MDT') + ' - ' + esc(r.titre || 'Rapport') + '</h1><div class="subline"><span>' + esc(c.numero) + '</span><span>Personne liee : ' + esc(p.nom || '-') + '</span><span>' + esc(r.statut || 'En cours') + '</span></div></div>',
        '<div class="actions"><button class="btn btn-ghost btn-small" onclick="' + callAttr('openMdtReportModal', c.id, p.id, r.id) + '">Modifier</button><button class="btn btn-red btn-small" onclick="' + callAttr('deleteMdtReport', c.id, p.id, r.id) + '">Dissocier</button></div>',
      '</div>',
      '<div class="report-detail-layout">',
        '<section class="panel section report-detail-main">',
          '<div class="kicker">MDT</div><h2>Informations du rapport</h2>',
          '<div class="report-grid">',
            identityRow('Numero', r.numero || 'MDT'),
            identityRow('Type', r.type || 'Rapport MDT'),
            identityRow('Date', r.date_rapport || r.date_arrestation || '-'),
            identityRow('Statut', r.statut || 'En cours'),
            identityRow('Agent redacteur', r.agent || '-'),
            identityRow('Agents impliques', r.agents_impliques || r.auteurs || '-'),
          '</div>',
          '<h3>Resume / description</h3><p class="text preline">' + esc(r.resume || 'Aucun resume renseigne.') + '</p>',
          '<h3>Chefs d inculpation</h3><p class="text preline">' + esc(charges || 'Aucun chef renseigne.') + '</p>',
          '<h3>Decision judiciaire</h3><p class="text preline">' + esc(r.decision || 'Aucune decision renseignee dans le lien CID.') + '</p>',
          '<div class="report-grid compact">',
            identityRow('Amende', r.amende ? money(r.amende) : '-'),
            identityRow('Peine', r.prison ? r.prison + ' UP' : '-'),
            identityRow('Dossier CID', r.dossier_cid || c.numero || '-'),
          '</div>',
        '</section>',
        '<aside class="report-side-grid">',
          reportSideBlock('Agents impliques', [r.agent, r.agents_impliques || r.auteurs].filter(Boolean).join(', ') || '-'),
          reportLinksBlock('Suspects', suspects.map(function(x) { return { label: x.nom || 'Suspect', action: callAttr('go', 'dossiers', { id: c.id, person: x.id }) }; })),
          reportLinksBlock('Civils', civilians.map(function(x) { return { label: x.nom || 'Civil', action: callAttr('go', 'dossiers', { id: c.id, person: x.id }) }; })),
          reportEvidenceBlock('Armes', c, weapons),
          reportEvidenceBlock('Vehicules', c, vehicles),
          reportEvidenceBlock('Saisies / preuves', c, seizures),
        '</aside>',
      '</div>',
    '</div>'
  ].join('');
}

function reportSideBlock(title, text) {
  return '<section class="panel section report-block"><h2>' + esc(title) + '</h2><p class="text preline">' + esc(text || '-') + '</p></section>';
}
function reportLinksBlock(title, rows) {
  return '<section class="panel section report-block"><h2>' + esc(title) + '</h2><div class="linked-chip-list">' + (rows.length ? rows.map(function(r) { return '<button class="linked-chip" onclick="' + r.action + '">' + esc(r.label) + '</button>'; }).join('') : '<span class="text">Aucun element.</span>') + '</div></section>';
}
function reportEvidenceBlock(title, c, rows) {
  return '<section class="panel section report-block"><h2>' + esc(title) + '</h2><div class="linked-chip-list">' + (rows.length ? rows.map(function(e) { return '<button class="linked-chip" onclick="' + callAttr('openEvidenceModal', c.id, e.id) + '">' + evidenceIcon(e.type) + ' ' + esc(e.scelle || e.type || 'Preuve') + '</button>'; }).join('') : '<span class="text">Aucun element.</span>') + '</div></section>';
}
function personEditForm(c, p) {
  return '<form id="personEditForm" class="person-edit-form" onsubmit="event.preventDefault();' + callAttr('savePersonProfile', c.id, p.id) + '">' +
    '<div class="form-grid">' +
      '<input name="nom" value="' + esc(p.nom) + '" placeholder="Nom / prenom">' +
      '<input name="alias" value="' + esc(p.alias || '') + '" placeholder="Alias">' +
      '<select name="type">' + options(PERSON_TYPES, p.type || 'Citoyen') + '</select>' +
      '<input name="tel" value="' + esc(p.tel || '') + '" placeholder="Telephone ex : 555-1234">' +
      '<select name="dangerosite">' + options(['Inconnue','Faible','Moyenne','Elevee','Critique'], p.dangerosite || 'Inconnue') + '</select>' +
      '<input name="statut_actuel" value="' + esc(p.statut_actuel || 'Actif') + '" placeholder="Statut actuel">' +
    '</div>' +
    '<textarea name="commentaires" rows="10" placeholder="Notes, habitudes, signalement, liens...">' + esc(p.commentaires || '') + '</textarea>' +
    '<button class="btn btn-blue btn-small">Sauvegarder</button></form>';
}
function personTabs(c, p, active) {
  var tabs = [
    ['general', 'Informations generales'],
    ['rapports', 'Rapports MDT'],
    ['dossiers', 'Dossiers CID lies'],
    ['preuves', 'Preuves liees'],
    ['notes', 'Notes'],
    ['journal', 'Journal des modifications']
  ];
  return '<div class="person-tabs">' + tabs.map(function(t) {
    return '<button class="' + (active === t[0] ? 'active' : '') + '" onclick="' + callAttr('go', 'dossiers', { id: c.id, person: p.id, personTab: t[0] }) + '">' + esc(t[1]) + '</button>';
  }).join('') + '</div>';
}
function personTabContent(c, p, tab) {
  if (tab === 'rapports') return personReportsPanel(c, p, false);
  if (tab === 'dossiers') return personLinkedCasesPanel(c, p);
  if (tab === 'preuves') return personLinkedEvidencePanel(c, p, false);
  if (tab === 'notes') return '<section class="panel section"><h2>Notes</h2><p class="text preline">' + esc(p.commentaires || 'Aucune note sur cette personne.') + '</p></section>';
  if (tab === 'journal') return personJournalPanel(c, p);
  return personGeneralPanel(c, p);
}
function personGeneralPanel(c, p) {
  var reports = personReports(p, c);
  return [
    '<div class="person-general-grid">',
      '<section class="panel section person-identity-panel">',
        '<div class="person-photo-large">' + personAvatar(p, 'large') + '</div>',
        '<div class="person-metrics">',
          chip('Role dossier', esc(p.type || '-')),
          chip('Dangerosite', esc(p.dangerosite || 'Inconnue')),
          chip('Statut', esc(p.statut_actuel || 'Actif')),
          chip('Rapports MDT', reports.length),
          chip('Preuves liees', linkedEvidenceForPerson(c, p, false).length),
        '</div>',
      '</section>',
      '<section class="panel section"><h2>Informations CID</h2>' + personEditForm(c, p) + '</section>',
    '</div>',
    personReportsPanel(c, p, false),
    personFilesPanel(c, p)
  ].join('');
}
function personFilesPanel(c, p) {
  var files = p.fichiers || [];
  return '<section class="panel section"><div class="panel-head-mini"><div><div class="kicker">Pieces personne</div><h2>Photos / fichiers</h2></div><button class="btn btn-ghost btn-small" onclick="' + callAttr('openPersonFileModal', c.id, p.id) + '">Ajouter fichier</button></div>' + (files.length ? '<div class="file-grid">' + files.map(function(f) { return fileCard(c, p, f); }).join('') + '</div>' : '<p class="text">Aucun fichier sur cette fiche.</p>') + '</section>';
}
function personReportsPanel(c, p, arrestOnly) {
  var reports = personReports(p, c);
  if (arrestOnly) reports = reports.filter(function(r) { return r.date_arrestation || r.lieu || reportCharges(r).length; });
  return '<section class="panel section judicial-panel"><div class="panel-head-mini"><div><div class="kicker">Historique judiciaire</div><h2>Rapports MDT</h2></div><button class="btn btn-gold btn-small" onclick="' + callAttr('openMdtReportModal', c.id, p.id) + '">+ Lier un rapport MDT</button></div>' + (reports.length ? '<div class="judicial-list">' + reports.map(function(r) { return reportCard(c, p, r); }).join('') + '</div>' : '<p class="text">Aucun rapport MDT lie a cette personne.</p>') + '</section>';
}
function reportCard(c, p, r) {
  var charges = r.charges_text || reportCharges(r).map(function(ch) { return ch.nom || ch; }).join(', ');
  return '<article class="judicial-card mdt-link-card">' +
    '<div class="case-report-top"><strong>RAPPORT MDT #' + esc(reportNumber(r)) + '</strong>' + badge(r.statut || 'En cours', /condam|classe|clos/i.test(r.statut || '') ? 'green' : 'gold') + '</div>' +
    '<h3>' + esc(r.titre || 'Rapport MDT lie') + '</h3>' +
    '<div class="report-grid compact">' +
      identityRow('Type', r.type || 'Rapport MDT') +
      identityRow('Date', r.date_rapport || r.date_arrestation || '-') +
      identityRow('Agent redacteur', r.agent || '-') +
      identityRow('Agents impliques', r.agents_impliques || r.auteurs || '-') +
      identityRow('Dossier CID', r.dossier_cid || c.numero || '-') +
      identityRow('Chefs', charges || '-') +
    '</div>' +
    '<p class="text preline">' + esc(r.resume || 'Aucun resume court renseigne.') + '</p>' +
    '<div class="actions"><button class="btn btn-ghost btn-small" onclick="' + callAttr('go', 'dossiers', { id: c.id, report: r.id, person: p.id }) + '">Voir les details</button><button class="btn btn-ghost btn-small" onclick="' + callAttr('openMdtReportModal', c.id, p.id, r.id) + '">Modifier</button><button class="btn btn-red btn-small" onclick="' + callAttr('deleteMdtReport', c.id, p.id, r.id) + '">Dissocier</button></div>' +
  '</article>';
}
function personChargesPanel(c, p) {
  var charges = [];
  personReports(p, c).forEach(function(r) {
    reportCharges(r).forEach(function(ch) { charges.push({ report: r.numero || 'MDT', charge: ch }); });
  });
  return '<section class="panel section"><h2>Chefs d inculpation</h2>' + (charges.length ? '<div class="charge-grid">' + charges.map(function(item) { return '<article class="charge-card"><strong>' + esc(item.charge.nom || item.charge) + '</strong><span>Rapport ' + esc(item.report) + '</span><em>' + money(item.charge.amende) + ' / ' + esc(item.charge.prison || 0) + ' UP</em></article>'; }).join('') + '</div>' : '<p class="text">Aucun chef d inculpation renseigne.</p>') + '</section>';
}
function personLinkedCasesPanel(c, p) {
  var rows = casesLoad().filter(function(item) {
    return (item.personnes || []).some(function(x) { return x.id === p.id || cleanDiscordDisplayName(x.nom).toLowerCase() === cleanDiscordDisplayName(p.nom).toLowerCase(); });
  });
  return '<section class="panel section"><h2>Dossiers CID lies</h2><div class="mini-list">' + (rows.length ? rows.map(function(item) { return '<button class="mini-row" onclick="' + callAttr('go', 'dossiers', { id: item.id }) + '"><span>' + esc(item.numero) + '</span><strong>' + caseTitleHtml(item) + '</strong>' + statusBadge(item.statut) + '</button>'; }).join('') : '<p class="text">Aucun dossier lie.</p>') + '</div></section>';
}
function personLinkedEvidencePanel(c, p, vehiclesOnly) {
  var rows = linkedEvidenceForPerson(c, p, vehiclesOnly);
  return '<section class="panel section"><h2>' + (vehiclesOnly ? 'Vehicules' : 'Preuves liees') + '</h2>' + (rows.length ? '<div class="evidence-card-grid">' + rows.map(function(e) { return evidenceCard(c, e); }).join('') + '</div>' : '<p class="text">Aucun element lie.</p>') + '</section>';
}
function personJournalPanel(c, p) {
  var items = (c.journal || []).filter(function(j) { return String(j.texte || '').toLowerCase().indexOf(String(p.nom || '').toLowerCase()) !== -1; });
  return '<section class="panel section"><h2>Journal des modifications</h2><div class="note-list">' + (items.length ? items.map(function(j) { return '<div class="note-item"><strong>' + esc(j.date || '-') + '</strong><span>' + esc(j.texte || '') + '</span></div>'; }).join('') : '<div class="note-item">Aucun journal lie a cette personne.</div>') + '</div></section>';
}
function totalArrests(p) {
  return personReports(p, null).filter(function(r) { return r.date_arrestation || r.lieu || reportCharges(r).length; }).length;
}
function personLinkMeta(p) {
  var items = [];
  if (p.rapport_mdt) items.push('<span>Rapport MDT ' + esc(p.rapport_mdt) + '</span>');
  if (p.rapport_event_url) items.push('<a class="inline-link" href="' + esc(p.rapport_event_url) + '" target="_blank" rel="noopener">Rapport evenement</a>');
  return items.join('');
}
function fileCard(c, p, f) {
  var media = attachmentHtml(f.attachment, functionName('previewPersonFile', c.id, p.id, f.id));
  return '<article class="file-card">' +
    '<button type="button" class="file-remove" onclick="event.stopPropagation();' + callAttr('deletePersonFile', c.id, p.id, f.id) + '">Supprimer</button>' +
    media +
    '<strong>' + esc(f.type || 'Fichier') + '</strong><br><small>' + esc(f.date || '-') + '</small><p class="text">' + esc(f.note || '') + '</p></article>';
}

function renderPeopleIndex() {
  var rows = [];
  casesLoad().forEach(function(c) { (c.personnes || []).forEach(function(p) { rows.push({ c: c, p: p }); }); });
  $('content').innerHTML = '<section class="panel section"><h2>Personnes CID</h2><table><thead><tr><th>Nom</th><th>Type</th><th>Telephone</th><th>Rapports MDT</th><th>Dossier</th></tr></thead><tbody>' + (rows.length ? rows.map(function(r) { return '<tr class="clickable" onclick="' + callAttr('go', 'dossiers', { id: r.c.id, person: r.p.id }) + '"><td><strong>' + esc(r.p.nom) + '</strong></td><td>' + badge(r.p.type, 'blue') + '</td><td>' + esc(r.p.tel || '-') + '</td><td>' + personReports(r.p, r.c).length + '</td><td>' + esc(r.c.numero) + ' - ' + esc(r.c.titre) + '</td></tr>'; }).join('') : '<tr><td colspan="5">Aucune personne.</td></tr>') + '</tbody></table></section>';
}
function renderEvidenceIndex() {
  var rows = [];
  casesLoad().forEach(function(c) { (c.preuves || []).forEach(function(e) { rows.push({ c: c, e: e }); }); });
  $('content').innerHTML = '<section class="panel section"><h2>Preuves CID</h2><table><thead><tr><th>Apercu</th><th>Scelle</th><th>Type</th><th>Infos</th><th>Dossier</th></tr></thead><tbody>' + (rows.length ? rows.map(function(r) { return '<tr class="clickable" onclick="' + callAttr('openEvidenceModal', r.c.id, r.e.id) + '"><td onclick="event.stopPropagation()">' + attachmentHtml(r.e.attachment, functionName('previewEvidence', r.c.id, r.e.id)) + '</td><td>' + esc(r.e.scelle) + '</td><td>' + evidenceTypeBadge(r.e.type) + '</td><td>' + esc(proofDetailsText(r.c, r.e) || r.e.description || '-') + '</td><td>' + esc(r.c.numero) + '</td></tr>'; }).join('') : '<tr><td colspan="5">Aucune preuve.</td></tr>') + '</tbody></table></section>';
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
async function resolveServerDisplayName() {
  if (!STATE.discordId) return displayNameFromOAuth();
  var roleIds = []
    .concat(typeof ROLE_AGENT_IDS !== 'undefined' ? ROLE_AGENT_IDS : [])
    .concat(typeof ROLE_ADMIN_IDS !== 'undefined' ? ROLE_ADMIN_IDS : [])
    .concat([EFFECTIVE_CID_ROLE_ID, CID_INVESTIGATOR_ROLE_ID])
    .filter(Boolean)
    .filter(function(roleId, index, list) { return list.indexOf(roleId) === index; });
  try {
    var res = await fetch(workerUrl('/discord/agents-roster', { guild_id: GUILD_ID, role_ids: roleIds.join(','), limit: 1000 }));
    if (!res.ok) return displayNameFromOAuth();
    var data = await res.json();
    var member = (data.agents || []).find(function(a) { return String(a.discord_id) === String(STATE.discordId); });
    if (member && (member.prenom || member.nom)) return cleanDiscordDisplayName((member.prenom || '') + ' ' + (member.nom || ''));
  } catch (e) {}
  return displayNameFromOAuth();
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
  var p = {
    id: uid('person'),
    nom: fd.get('nom'),
    type: fd.get('type'),
    tel: fd.get('tel') || '',
    discord_id: fd.get('discord_id') || '',
    rapport_mdt: fd.get('rapport_mdt') || '',
    rapport_event_url: fd.get('rapport_event_url') || '',
    commentaires: fd.get('commentaires') || '',
    alias: '',
    date_naissance: '',
    adresse: '',
    profession: '',
    sexe: '',
    nationalite: '',
    organisation: '',
    dangerosite: 'Inconnue',
    statut_actuel: 'Actif',
    permis: '',
    casier: 'A verifier',
    mandats: '',
    photo: null,
    fichiers: [],
    mdt_reports: []
  };
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
  p.alias = fd.get('alias') || '';
  p.type = fd.get('type') || p.type;
  p.tel = fd.get('tel') || '';
  p.dangerosite = fd.get('dangerosite') || 'Inconnue';
  p.statut_actuel = fd.get('statut_actuel') || 'Actif';
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
function openPersonPhotoModal(caseId, pid) {
  openModal('Photo de profil', '<form id="personPhotoForm"><div class="form-grid"><input class="full" name="photo" type="file" accept="image/*" required><div id="personPhotoError" class="form-error full"></div></div></form>',
    '<button type="button" class="btn btn-ghost" onclick="closeModal()">Annuler</button><button type="button" class="btn btn-gold" onclick="' + callAttr('savePersonPhoto', caseId, pid) + '">Sauvegarder</button>');
}
async function savePersonPhoto(caseId, pid) {
  try {
    setModalError('personPhotoError', '');
    var c = caseGet(caseId);
    var p = c && (c.personnes || []).find(function(x) { return x.id === pid; });
    if (!p) throw new Error('Personne introuvable.');
    var photo = await readFile($('personPhotoForm').querySelector('input[type=file]'));
    if (!photo) throw new Error('Selectionne une image.');
    applyPersonPhotoEverywhere(p, photo);
    closeModal();
    renderApp();
  } catch (e) {
    setModalError('personPhotoError', e.message || 'Impossible de sauvegarder la photo.');
  }
}
function deletePersonPhoto(caseId, pid) {
  openConfirmModal('Supprimer la photo', 'La photo de profil de cette personne sera retiree.', 'danger', callAttr('confirmDeletePersonPhoto', caseId, pid));
}
function confirmDeletePersonPhoto(caseId, pid) {
  var c = caseGet(caseId);
  var p = c && (c.personnes || []).find(function(x) { return x.id === pid; });
  if (p) applyPersonPhotoEverywhere(p, null);
  closeModal();
  renderApp();
}
function applyPersonPhotoEverywhere(reference, photo) {
  var refName = cleanDiscordDisplayName(reference.nom || '').toLowerCase();
  var all = casesLoad();
  all.forEach(function(item) {
    (item.personnes || []).forEach(function(p) {
      var sameId = p.id === reference.id;
      var sameName = refName && cleanDiscordDisplayName(p.nom || '').toLowerCase() === refName;
      if (sameId || sameName) p.photo = photo;
    });
  });
  casesSave(all);
}
function chargeOptions(selected) {
  selected = selected || [];
  return '<input class="full" id="chargeSearch" type="search" placeholder="Rechercher une infraction..." oninput="filterChargeCatalog(this.value)"><div class="charge-picker" id="chargePicker">' + CHARGES_CATALOG.map(function(ch, i) {
    var checked = selected.some(function(s) { return (s.nom || s) === ch.nom; });
    return '<label data-charge="' + esc(ch.nom.toLowerCase()) + '"><input type="checkbox" name="charges" value="' + esc(ch.nom) + '"' + (checked ? ' checked' : '') + '><span><strong>' + esc(ch.nom) + '</strong><em>' + money(ch.amende) + ' / ' + ch.prison + ' UP</em></span></label>';
  }).join('') + '</div>';
}
function filterChargeCatalog(value) {
  var q = String(value || '').toLowerCase();
  Array.prototype.forEach.call(document.querySelectorAll('#chargePicker label'), function(label) {
    label.style.display = !q || String(label.getAttribute('data-charge') || '').indexOf(q) !== -1 ? '' : 'none';
  });
}
function openMdtReportModal(caseId, pid, reportId) {
  var c = caseGet(caseId);
  var p = c && (c.personnes || []).find(function(x) { return x.id === pid; });
  if (!p) return;
  var reports = p.mdt_reports || [];
  var r = reportId ? reports.find(function(x) { return x.id === reportId; }) : null;
  openModal(r ? 'Modifier le rapport MDT' : 'Ajouter un rapport MDT',
    '<form id="mdtReportForm"><div class="form-grid">' +
      '<input name="numero" placeholder="Numero du rapport MDT" value="' + esc(r && r.numero || '') + '">' +
      '<input name="titre" placeholder="Titre du rapport" value="' + esc(r && r.titre || '') + '">' +
      '<input name="type" placeholder="Type du rapport" value="' + esc(r && r.type || 'Arrestation') + '">' +
      '<input name="date_rapport" type="datetime-local" value="' + esc(toDateTimeLocal(r && (r.date_rapport || r.date_arrestation) || '')) + '">' +
      '<input name="agent" placeholder="Agent redacteur" value="' + esc(r && r.agent || '') + '">' +
      '<input name="agents_impliques" placeholder="Agents impliques" value="' + esc(r && (r.agents_impliques || r.auteurs) || '') + '">' +
      '<select name="statut">' + options(['Brouillon','En cours','Transmis procureur','Condamne','Relaxe','Classe'], r && r.statut || 'En cours') + '</select>' +
      '<textarea class="full" name="charges_text" rows="3" placeholder="Chefs d inculpation">' + esc(r && (r.charges_text || reportCharges(r).map(function(ch) { return ch.nom || ch; }).join('\\n')) || '') + '</textarea>' +
      '<textarea class="full" name="resume" rows="5" placeholder="Resume facultatif">' + esc(r && r.resume || '') + '</textarea>' +
    '</div></form>',
    '<button type="button" class="btn btn-ghost" onclick="closeModal()">Annuler</button>' +
    (r ? '<button type="button" class="btn btn-red" onclick="' + callAttr('deleteMdtReport', caseId, pid, r.id) + '">Dissocier</button>' : '') +
    '<button type="button" class="btn btn-gold" onclick="' + callAttr('saveMdtReport', caseId, pid, reportId || '') + '">' + (r ? 'Sauvegarder' : 'Lier le rapport') + '</button>');
}
function saveMdtReport(caseId, pid, reportId) {
  var c = caseGet(caseId);
  var p = c && (c.personnes || []).find(function(x) { return x.id === pid; });
  if (!p) return;
  var fd = new FormData($('mdtReportForm'));
  p.mdt_reports = p.mdt_reports || [];
  var r = reportId ? p.mdt_reports.find(function(x) { return x.id === reportId; }) : null;
  if (!r) {
    r = { id: uid('mdt') };
    p.mdt_reports.unshift(r);
  }
  r.numero = fd.get('numero') || ('MDT-' + new Date().getFullYear() + '-' + String(p.mdt_reports.length).padStart(4, '0'));
  r.titre = fd.get('titre') || '';
  r.type = fd.get('type') || 'Rapport MDT';
  r.date_rapport = fromDateTimeLocal(fd.get('date_rapport') || '');
  r.date_arrestation = r.date_rapport;
  r.agent = fd.get('agent') || '';
  r.agents_impliques = fd.get('agents_impliques') || '';
  r.auteurs = r.agents_impliques;
  r.dossier_cid = c.numero || '';
  r.statut = fd.get('statut') || 'En cours';
  r.charges_text = fd.get('charges_text') || '';
  r.charges = r.charges_text ? String(r.charges_text).split(/\n|,/).map(function(name) { return { nom: name.trim(), amende: '', prison: '' }; }).filter(function(ch) { return ch.nom; }) : [];
  r.resume = fd.get('resume') || '';
  c.journal = c.journal || [];
  c.journal.unshift({ date: nowLabel(), texte: 'Rapport MDT mis a jour pour ' + (p.nom || 'personne') + ': ' + r.numero, type: 'system' });
  caseUpsert(c);
  closeModal();
  STATE.route = { page: 'dossiers', id: c.id, person: p.id, personTab: 'rapports' };
  renderApp();
}
function deleteMdtReport(caseId, pid, reportId) {
  openConfirmModal('Supprimer le rapport MDT', 'Ce rapport sera retire de l historique judiciaire de cette personne.', 'danger', callAttr('confirmDeleteMdtReport', caseId, pid, reportId));
}
function confirmDeleteMdtReport(caseId, pid, reportId) {
  var c = caseGet(caseId);
  var p = c && (c.personnes || []).find(function(x) { return x.id === pid; });
  if (p) p.mdt_reports = (p.mdt_reports || []).filter(function(r) { return r.id !== reportId; });
  caseUpsert(c);
  closeModal();
  renderApp();
}
function toDateTimeLocal(value) {
  if (!value) return '';
  return String(value).replace(' ', 'T').slice(0, 16);
}
function fromDateTimeLocal(value) {
  return value ? String(value).replace('T', ' ') : '';
}

function openEvidenceModal(caseId, evidenceId) {
  var c = caseGet(caseId);
  var e = evidenceId ? (c.preuves || []).find(function(x) { return x.id === evidenceId; }) : null;
  var d = e && e.details || {};
  var suspectId = d.suspect_id || '';
  var suspects = '<option value="">Non attribue</option>' + (c.personnes || []).filter(function(p) { return p.type === 'Suspect'; }).map(function(p) { return '<option value="' + esc(p.id) + '"' + (p.id === suspectId ? ' selected' : '') + '>' + esc(p.nom) + '</option>'; }).join('');
  openModal(e ? 'Modifier la preuve' : 'Ajouter une preuve',
    '<form id="evidenceForm"><div class="form-grid">' +
      '<select name="type" id="evidenceType" onchange="toggleEvidenceFields()">' + evidenceOptions(managedOptions('types_preuves'), e && e.type || 'Photo') + '</select>' +
      '<div id="fileField"><input name="fichier" type="file" accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.txt">' + (e && e.attachment ? '<div class="text mini">Fichier actuel : ' + esc(e.attachment.name || 'piece jointe') + '</div>' : '') + '</div>' +
      '<div id="weaponFields" class="form-grid full hidden"><input name="type_arme" placeholder="Type d\'arme" value="' + esc(d.type_arme || '') + '"><input name="numero_serie" placeholder="Numero de serie" value="' + esc(d.numero_serie || '') + '"><select name="suspect_arme">' + suspects + '</select></div>' +
      '<div id="drugFields" class="form-grid full hidden"><input name="type_drogue" placeholder="Type de drogue" value="' + esc(d.type_drogue || '') + '"><input name="quantite" placeholder="Quantite" value="' + esc(d.quantite || '') + '"><select name="suspect_drogue">' + suspects + '</select></div>' +
      '<div id="vehicleFields" class="form-grid full hidden"><input name="modele" placeholder="Modele du vehicule" value="' + esc(d.modele || '') + '"><input name="plaque" placeholder="Plaque" value="' + esc(d.plaque || '') + '"><select name="suspect_vehicule">' + suspects + '</select></div>' +
      '<textarea class="full" name="description" rows="4" placeholder="Description / contexte">' + esc(e && e.description || '') + '</textarea>' +
      '<div id="evidenceError" class="form-error full"></div>' +
    '</div></form>',
    '<button type="button" class="btn btn-ghost" onclick="closeModal()">Annuler</button>' +
    (e && e.attachment ? '<button type="button" class="btn btn-red" onclick="' + callAttr('deleteEvidenceAttachment', caseId, evidenceId) + '">Retirer fichier</button>' : '') +
    (e ? '<button type="button" class="btn btn-red" onclick="' + callAttr('deleteEvidence', caseId, evidenceId) + '">Supprimer</button>' : '') +
    '<button type="button" class="btn btn-gold" onclick="' + callAttr('saveEvidence', caseId, evidenceId || '') + '">' + (e ? 'Sauvegarder' : 'Ajouter') + '</button>'
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
async function saveEvidence(caseId, evidenceId) {
  try {
    setModalError('evidenceError', '');
    var c = caseGet(caseId);
    if (!c) throw new Error('Dossier introuvable.');
    c.preuves = c.preuves || [];
    var existing = evidenceId ? c.preuves.find(function(x) { return x.id === evidenceId; }) : null;
    var f = $('evidenceForm');
    var fd = new FormData(f);
    var type = fd.get('type');
    var details = {};
    if (type === 'Arme') details = { type_arme: fd.get('type_arme') || '', numero_serie: fd.get('numero_serie') || '', suspect_id: fd.get('suspect_arme') || '' };
    if (type === 'Drogue') details = { type_drogue: fd.get('type_drogue') || '', quantite: fd.get('quantite') || '', suspect_id: fd.get('suspect_drogue') || '' };
    if (type === 'Vehicule') details = { modele: fd.get('modele') || '', plaque: fd.get('plaque') || '', suspect_id: fd.get('suspect_vehicule') || '' };
    var seal = existing && existing.scelle || 'SC-' + new Date().getFullYear() + '-' + String(c.preuves.length + 1).padStart(4, '0');
    var newAttachment = await readFile(f.querySelector('input[type=file]'));
    var saved = existing || { id: uid('evidence'), scelle: seal, date: nowLabel() };
    saved.type = type;
    saved.description = fd.get('description') || '';
    saved.details = details;
    saved.attachment = newAttachment || saved.attachment || null;
    if (!existing) c.preuves.push(saved);
    c.journal = c.journal || [];
    c.journal.unshift({ date: nowLabel(), texte: (existing ? 'Preuve modifiee: ' : 'Preuve ajoutee: ') + seal, type: 'system' });
    caseUpsert(c);
    closeModal();
    renderApp();
  } catch (e) {
    setModalError('evidenceError', e && e.name === 'QuotaExceededError' ? 'Stockage navigateur plein. Supprime quelques grosses preuves ou utilise une image plus legere.' : (e.message || 'Impossible d ajouter la preuve.'));
  }
}

function deleteEvidence(caseId, evidenceId) {
  openConfirmModal('Supprimer la preuve', 'Cette preuve sera retiree du dossier CID.', 'danger', callAttr('confirmDeleteEvidence', caseId, evidenceId));
}
function deleteEvidenceAttachment(caseId, evidenceId) {
  openConfirmModal('Retirer le fichier', 'Le fichier joint sera retire de cette preuve. La preuve restera dans le dossier.', 'danger', callAttr('confirmDeleteEvidenceAttachment', caseId, evidenceId));
}
function confirmDeleteEvidenceAttachment(caseId, evidenceId) {
  var c = caseGet(caseId);
  if (!c) return;
  var e = (c.preuves || []).find(function(x) { return x.id === evidenceId; });
  if (!e) return;
  e.attachment = null;
  c.journal = c.journal || [];
  c.journal.unshift({ date: nowLabel(), texte: 'Fichier retire de la preuve: ' + (e.scelle || '-'), type: 'system' });
  caseUpsert(c);
  closeModal();
  renderApp();
}
function confirmDeleteEvidence(caseId, evidenceId) {
  var c = caseGet(caseId);
  if (!c) return;
  c.preuves = (c.preuves || []).filter(function(e) { return e.id !== evidenceId; });
  caseUpsert(c);
  closeModal();
  renderApp();
}

function openNoteModal(caseId, noteIndex) {
  var c = caseGet(caseId);
  var hasNote = noteIndex !== undefined && noteIndex !== null && String(noteIndex) !== '';
  var index = hasNote ? Number(noteIndex) : -1;
  var note = hasNote && c && c.journal ? c.journal[index] : null;
  if (hasNote && (!note || note.type !== 'note')) {
    openInfoModal('Note introuvable', 'Cette note n existe plus dans le dossier CID.');
    return;
  }
  var body = '<form id="noteForm"><textarea name="note" rows="8" placeholder="Note CID..." required>' + esc(note && note.texte ? note.texte : '') + '</textarea></form>';
  var actions = '<button type="button" class="btn btn-ghost" onclick="closeModal()">Annuler</button>' +
    (hasNote ? '<button type="button" class="btn btn-red" onclick="' + callAttr('deleteNote', caseId, index) + '">Supprimer</button>' : '') +
    '<button type="button" class="btn btn-gold" onclick="' + callAttr('saveNote', caseId, hasNote ? index : '') + '">' + (hasNote ? 'Sauvegarder' : 'Ajouter') + '</button>';
  openModal(hasNote ? 'Modifier la note' : 'Ajouter une note', body, actions);
}
function saveNote(caseId, noteIndex) {
  var c = caseGet(caseId);
  var txt = new FormData($('noteForm')).get('note');
  c.journal = c.journal || [];
  var hasNote = noteIndex !== undefined && noteIndex !== null && String(noteIndex) !== '';
  var index = hasNote ? Number(noteIndex) : -1;
  if (hasNote && c.journal[index] && c.journal[index].type === 'note') {
    c.journal[index].texte = txt;
    c.journal[index].updated_at = nowLabel();
  } else {
    c.journal.unshift({ id: uid('note'), date: nowLabel(), texte: txt, type: 'note' });
  }
  caseUpsert(c);
  closeModal();
  renderApp();
}
function deleteNote(caseId, noteIndex) {
  openConfirmModal('Supprimer la note', 'Cette note sera retiree du dossier CID.', 'danger', callAttr('confirmDeleteNote', caseId, noteIndex));
}
function confirmDeleteNote(caseId, noteIndex) {
  var c = caseGet(caseId);
  if (!c) return;
  var index = Number(noteIndex);
  if (c.journal && c.journal[index] && c.journal[index].type === 'note') {
    c.journal.splice(index, 1);
  }
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

function deletePersonFile(caseId, pid, fileId) {
  openConfirmModal('Supprimer le fichier', 'Ce fichier sera retire de la fiche personne.', 'danger', callAttr('confirmDeletePersonFile', caseId, pid, fileId));
}
function confirmDeletePersonFile(caseId, pid, fileId) {
  var c = caseGet(caseId);
  if (!c) return;
  var p = (c.personnes || []).find(function(x) { return x.id === pid; });
  if (!p) return;
  p.fichiers = (p.fichiers || []).filter(function(f) { return f.id !== fileId; });
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
  if (STATE.displayName) return STATE.displayName;
  return displayNameFromOAuth();
}
function displayNameFromOAuth() {
  var meta = STATE.user && STATE.user.user_metadata || {};
  var identity = STATE.user && STATE.user.identities && STATE.user.identities.find(function(i) { return i.provider === 'discord'; });
  var data = identity && identity.identity_data || {};
  var raw = meta.full_name || meta.name || meta.global_name || data.full_name || data.name || data.global_name || meta.preferred_username || data.preferred_username || meta.user_name || meta.username || data.user_name || data.username || 'CID';
  return cleanDiscordDisplayName(raw);
}
function cleanDiscordDisplayName(raw) {
  var name = String(raw || '').trim();
  name = name.replace(/^\s*\[[^\]]+\]\s*/, '');
  name = name.replace(/^\s*\d+\s*[-|]\s*/, '');
  name = name.replace(/\s+/g, ' ').trim();
  return name || 'CID';
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

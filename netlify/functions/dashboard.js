// ============================================================
// IMMOLEAD · Fonction serverless "Dashboard"
// Emplacement : netlify/functions/dashboard.js
// Appel : /.netlify/functions/dashboard  (en-tête x-dash-token requis)
//
// Variables d'environnement à créer dans Netlify :
//   DASHBOARD_TOKEN            <- une phrase secrète de votre choix
//   STRIPE_SECRET_KEY          <- clé secrète Stripe (sk_live_… ou sk_test_…)
//   SUPABASE_URL               <- déjà créée
//   SUPABASE_SERVICE_ROLE_KEY  <- déjà créée
//
// Toute l'agrégation se fait ici, côté serveur. Sans le token,
// aucune donnée ne quitte cette fonction.
// ============================================================

const TOKEN      = process.env.DASHBOARD_TOKEN;
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY;
const SUPA_URL   = process.env.SUPABASE_URL;
const SUPA_KEY   = process.env.SUPABASE_SERVICE_ROLE_KEY;

const JOURS_SANS_LEAD_ALERTE = 14;   // seuil d'alerte "plus de leads"
const BAISSE_ALERTE_PCT      = 40;   // seuil d'alerte "volume en baisse"

// Rémunération de l'équipe, par client. Modifiez ici si les montants changent.
const COM_CLOSER = 250;   // € une seule fois, à la signature
const COM_SETTER = 20;    // € une seule fois, à la signature
const COM_MEDIA  = 250;   // € chaque mois, tant que le client est actif

exports.handler = async (event) => {
  const H = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };

  const fourni = (event.headers['x-dash-token'] || event.headers['X-Dash-Token'] || '').trim();
  if (!TOKEN || fourni !== TOKEN) {
    return { statusCode: 401, headers: H, body: JSON.stringify({ error: 'non autorisé' }) };
  }

  const diag = {};
  try {
    const [stripe, supa] = await Promise.all([
      chargerStripe(diag).catch(e => { diag.erreur_stripe = e.message; return null; }),
      chargerSupabase(diag).catch(e => { diag.erreur_supabase = e.message; return null; })
    ]);
    return ok(H, assembler(stripe, supa, diag));
  } catch (e) {
    console.error('dashboard_error', e.message);
    return { statusCode: 500, headers: H, body: JSON.stringify({ error: e.message }) };
  }
};

// ---------------------------------------------------------------
// STRIPE
// ---------------------------------------------------------------
async function stripeGet(chemin, params) {
  const qs = new URLSearchParams(params || {}).toString();
  const r = await fetch('https://api.stripe.com/v1/' + chemin + (qs ? '?' + qs : ''), {
    headers: { Authorization: 'Bearer ' + STRIPE_KEY }
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error('Stripe ' + r.status + ' — ' + t.slice(0, 160));
  }
  return r.json();
}

/* Parcourt toutes les pages d'une liste Stripe */
async function stripeListe(chemin, params, max) {
  const out = [];
  let apres = null;
  for (let i = 0; i < (max || 10); i++) {
    const p = Object.assign({ limit: 100 }, params);
    if (apres) p.starting_after = apres;
    const page = await stripeGet(chemin, p);
    out.push(...(page.data || []));
    if (!page.has_more || !page.data.length) break;
    apres = page.data[page.data.length - 1].id;
  }
  return out;
}

/* Ramène un montant à son équivalent mensuel */
function mensualiser(montant, intervalle, nb) {
  const n = nb || 1;
  if (intervalle === 'month') return montant / n;
  if (intervalle === 'year')  return montant / (12 * n);
  if (intervalle === 'week')  return montant * 52 / 12 / n;
  if (intervalle === 'day')   return montant * 365 / 12 / n;
  return 0;
}

async function chargerStripe(diag) {
  if (!STRIPE_KEY) throw new Error('STRIPE_SECRET_KEY absente');
  const t0 = Date.now();

  const abos = await stripeListe('subscriptions', { status: 'all', 'expand[]': 'data.customer' }, 5);

  // pas de filtre de date : on veut le cumul depuis le premier euro encaissé
  const paiements = await stripeListe('charges', {}, 20);

  diag.ms_stripe = Date.now() - t0;
  diag.abonnements_bruts = abos.length;
  diag.paiements = paiements.length;

  return { abos, paiements };
}

// ---------------------------------------------------------------
// SUPABASE
// ---------------------------------------------------------------
async function supaGet(chemin) {
  const r = await fetch(SUPA_URL + '/rest/v1/' + chemin, {
    headers: { apikey: SUPA_KEY, Authorization: 'Bearer ' + SUPA_KEY }
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error('Supabase ' + r.status + ' — ' + t.slice(0, 160));
  }
  return r.json();
}

async function chargerSupabase(diag) {
  if (!SUPA_URL || !SUPA_KEY) throw new Error('identifiants Supabase absents');
  const t0 = Date.now();
  const [clients, leads] = await Promise.all([
    supaGet('clients?select=*&limit=500'),
    supaGet('leads?select=client_id,date&order=date.desc&limit=20000')
  ]);
  diag.ms_supabase = Date.now() - t0;
  diag.clients = clients.length;
  diag.leads   = leads.length;
  return { clients, leads };
}

// ---------------------------------------------------------------
// ASSEMBLAGE
// ---------------------------------------------------------------
function normaliser(s) {
  return String(s || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function assembler(stripe, supa, diag) {
  const maintenant = Date.now();
  const jour = 86400000;
  const debutMois = new Date(); debutMois.setDate(1); debutMois.setHours(0,0,0,0);

  // ---- abonnements ----
  let mrr = 0, actifs = 0, impayes = 0;
  const parClientStripe = new Map();

  (stripe ? stripe.abos : []).forEach(a => {
    const vivant = ['active', 'trialing'].includes(a.status);
    const souci  = ['past_due', 'unpaid', 'incomplete'].includes(a.status);
    let m = 0;
    (a.items && a.items.data ? a.items.data : []).forEach(it => {
      const p = it.price || {};
      const rec = p.recurring || {};
      m += mensualiser((p.unit_amount || 0) * (it.quantity || 1), rec.interval, rec.interval_count);
    });
    if (vivant) { mrr += m; actifs++; }
    if (souci) impayes++;

    const cust = a.customer || {};
    const custId = typeof cust === 'object' ? cust.id : cust;
    const nom = typeof cust === 'object' ? (cust.name || cust.email || '') : '';
    const email = (typeof cust === 'object' ? cust.email : '') || '';
    const fiche = {
      customer_id: custId || '', nom, email,
      statut: a.status, mrr: m,
      depuis: a.start_date ? a.start_date * 1000 : null,
      fin_periode: a.current_period_end ? a.current_period_end * 1000 : null,
      annulation_prevue: !!a.cancel_at_period_end
    };
    // trois clés d'accès : identifiant Stripe, email, nom normalisé
    if (custId) parClientStripe.set(custId, fiche);
    if (email)  parClientStripe.set('email:' + normaliser(email), fiche);
    if (nom)    parClientStripe.set(normaliser(nom), fiche);
  });

  // ---- chiffre d'affaires ----
  let caMois = 0, caTotal = 0;
  const parMois = new Map();
  const payeParClient = new Map();   // customer_id -> { total, premier, dernier, nb }

  (stripe ? stripe.paiements : []).forEach(f => {
    if (f.status !== 'succeeded') return;
    const montant = ((f.amount || 0) - (f.amount_refunded || 0)) / 100;
    if (montant <= 0) return;
    const ts = (f.created || 0) * 1000;
    const d = new Date(ts);
    caTotal += montant;
    if (d >= debutMois) caMois += montant;
    const cle = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
    parMois.set(cle, (parMois.get(cle) || 0) + montant);

    const cid = typeof f.customer === 'object' ? (f.customer && f.customer.id) : f.customer;
    if (cid) {
      const e = payeParClient.get(cid) || { total: 0, premier: ts, dernier: ts, nb: 0 };
      e.total += montant; e.nb++;
      if (ts < e.premier) e.premier = ts;
      if (ts > e.dernier) e.dernier = ts;
      payeParClient.set(cid, e);
    }
  });
  const historique = [...parMois.entries()].sort().slice(-12)
    .map(([mois, montant]) => ({ mois, montant: Math.round(montant) }));

  // ---- leads par client ----
  const compte = new Map();
  (supa ? supa.leads : []).forEach(l => {
    const id = l.client_id || 'inconnu';
    const t = l.date ? new Date(l.date).getTime() : 0;
    if (!compte.has(id)) compte.set(id, { total: 0, m30: 0, m30p: 0, dernier: 0 });
    const c = compte.get(id);
    c.total++;
    if (t > c.dernier) c.dernier = t;
    const age = (maintenant - t) / jour;
    if (age <= 30) c.m30++;
    else if (age <= 60) c.m30p++;
  });

  // ---- fusion ----
  const clients = (supa ? supa.clients : []).map(c => {
    // 1) identifiant Stripe explicite  2) email  3) nom normalisé
    let st = null, rattachement = null;
    if (c.stripe_customer_id) {
      st = parClientStripe.get(c.stripe_customer_id) || null;
      if (st) rattachement = 'id';
    }
    if (!st && c.email) {
      st = parClientStripe.get('email:' + normaliser(c.email)) || null;
      if (st) rattachement = 'email';
    }
    if (!st) {
      st = parClientStripe.get(normaliser(c.nom)) || null;
      if (st) rattachement = 'nom';
    }
    const l = compte.get(c.id) || { total: 0, m30: 0, m30p: 0, dernier: 0 };
    const joursSansLead = l.dernier ? Math.floor((maintenant - l.dernier) / jour) : null;
    const evolution = l.m30p > 0 ? Math.round((l.m30 - l.m30p) / l.m30p * 100) : null;

    const alertes = [];
    if (st && ['past_due','unpaid','incomplete'].includes(st.statut)) alertes.push('paiement en échec');
    if (st && st.annulation_prevue) alertes.push('résiliation prévue');
    if (joursSansLead === null) alertes.push('aucun lead livré');
    else if (joursSansLead >= JOURS_SANS_LEAD_ALERTE) alertes.push('aucun lead depuis ' + joursSansLead + ' jours');
    if (evolution !== null && evolution <= -BAISSE_ALERTE_PCT) alertes.push('volume en baisse de ' + Math.abs(evolution) + ' %');
    if (!st) alertes.push(c.stripe_customer_id
      ? 'identifiant Stripe inconnu'
      : 'non rapproché de Stripe');
    else if (rattachement === 'nom') alertes.push('rapproché par nom, à fiabiliser');

    const paye = (st && st.customer_id) ? payeParClient.get(st.customer_id) : null;

    // Mois facturés : du premier paiement à aujourd'hui si le client est encore
    // actif, sinon jusqu'à son dernier paiement. Le mois de signature compte.
    let moisActifs = 0, coutUnique = 0, coutMensuel = 0;
    if (paye) {
      const vivant = st && ['active', 'trialing', 'past_due'].includes(st.statut);
      const fin = vivant ? maintenant : paye.dernier;
      moisActifs = Math.max(1, Math.floor((fin - paye.premier) / (30.44 * jour)) + 1);
      coutUnique  = COM_CLOSER + COM_SETTER;
      coutMensuel = COM_MEDIA * moisActifs;
    }
    const coutTotal = coutUnique + coutMensuel;
    const marge = (paye ? Math.round(paye.total) : 0) - coutTotal;

    return {
      mois_actifs: moisActifs,
      cout_total: coutTotal,
      cout_unique: coutUnique,
      cout_mensuel_cumule: coutMensuel,
      marge: marge,
      id: c.id,
      nom: c.nom || '(sans nom)',
      statut: st ? st.statut : null,
      total_paye: paye ? Math.round(paye.total) : 0,
      nb_paiements: paye ? paye.nb : 0,
      premier_paiement: paye ? paye.premier : null,
      dernier_paiement: paye ? paye.dernier : null,
      rattachement,
      stripe_customer_id: st ? st.customer_id : (c.stripe_customer_id || null),
      mrr: st ? Math.round(st.mrr / 100) : 0,
      client_depuis: st ? st.depuis : null,
      prochaine_echeance: st ? st.fin_periode : null,
      leads_total: l.total,
      leads_30j: l.m30,
      leads_30j_precedents: l.m30p,
      evolution_pct: evolution,
      dernier_lead: l.dernier || null,
      jours_sans_lead: joursSansLead,
      alertes
    };
  }).sort((a, b) => b.mrr - a.mrr || b.leads_30j - a.leads_30j);

  // abonnés Stripe sans fiche Supabase
  const rattaches = new Set();
  clients.forEach(c => { if (c.stripe_customer_id && c.statut) rattaches.add(c.stripe_customer_id); });
  const vus = new Set();
  const orphelins = [];
  parClientStripe.forEach(v => {
    if (!v.customer_id || vus.has(v.customer_id)) return;
    vus.add(v.customer_id);
    if (rattaches.has(v.customer_id)) return;
    if (!['active','trialing','past_due'].includes(v.statut)) return;
    const pv = payeParClient.get(v.customer_id);
    orphelins.push({
      nom: v.nom, email: v.email, statut: v.statut,
      mrr: Math.round(v.mrr / 100), customer_id: v.customer_id,
      total_paye: pv ? Math.round(pv.total) : 0
    });
  });

  const leads30 = clients.reduce((s, c) => s + c.leads_30j, 0);
  const leadsTotal = clients.reduce((s, c) => s + c.leads_total, 0);

  return {
    genere_le: new Date().toISOString(),
    synthese: {
      mrr: Math.round(mrr / 100),
      abonnements_actifs: actifs,
      paiements_en_echec: impayes,
      ca_mois: Math.round(caMois),
      leads_30j: leads30,
      leads_total: leadsTotal,
      leads_moyen_par_client: actifs ? Math.round(leads30 / actifs * 10) / 10 : 0,
      clients: clients.length,
      ca_depuis_debut: Math.round(caTotal),
      couts_cumules: clients.reduce((s, c) => s + (c.cout_total || 0), 0),
      marge_cumulee: clients.reduce((s, c) => s + (c.marge || 0), 0),
      cout_mensuel_equipe: COM_MEDIA * actifs,
      mrr_net: Math.round(mrr / 100) - COM_MEDIA * actifs,
      remuneration: { closer: COM_CLOSER, setter: COM_SETTER, media_buyer: COM_MEDIA },
      panier_moyen: clients.length
        ? Math.round(clients.reduce((s, c) => s + (c.total_paye || 0), 0) / clients.length)
        : 0
    },
    historique,
    clients,
    orphelins,
    diag
  };
}

function ok(H, obj) { return { statusCode: 200, headers: H, body: JSON.stringify(obj) }; }

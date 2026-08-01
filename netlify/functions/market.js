// ============================================================
// IMMOLEAD · Fonction serverless "Données marché DVF"
// Emplacement dans le repo : netlify/functions/market.js
// Appel front : /.netlify/functions/market?cp=54000
// Diagnostic  : /.netlify/functions/market?cp=54000&debug=1
//
// SOURCES (officielles, hébergées par l'État) :
//   1. geo.api.gouv.fr        -> communes d'un code postal (codes INSEE)
//   2. files.data.gouv.fr     -> DVF géolocalisées, 1 CSV par commune et par année
//      https://files.data.gouv.fr/geo-dvf/latest/csv/<annee>/communes/<dep>/<insee>.csv
//
// Variables d'environnement (Netlify) :
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
// ============================================================

const SUPA_URL       = process.env.SUPABASE_URL;
const SUPA_KEY       = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CACHE_TABLE    = 'market_data_cache';
const CACHE_TTL_DAYS = 30;

const MAX_COMMUNES   = 4;     // communes interrogées par code postal
const ECART_TENDANCE = 3;     // années de recul pour la tendance
const VOL_MIN_MEDIANE  = 20;
const VOL_MIN_M2       = 30;
const VOL_MIN_TENDANCE = 40;

const GEO_URL = cp =>
  `https://geo.api.gouv.fr/communes?codePostal=${cp}&fields=code,nom,population&format=json`;
const DVF_CSV = (annee, dep, insee) =>
  `https://files.data.gouv.fr/geo-dvf/latest/csv/${annee}/communes/${dep}/${insee}.csv`;

exports.handler = async (event) => {
  const H  = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  const q  = event.queryStringParameters || {};
  const cp = (q.cp || '').trim();
  const debug = q.debug === '1';

  if (!/^\d{5}$/.test(cp)) {
    return { statusCode: 400, headers: H, body: JSON.stringify({ error: 'code_postal invalide' }) };
  }

  if (zoneNonCouverte(cp)) {
    return ok(H, {
      code_postal: cp, couvert: false, panneau: false,
      message: "Transactions non diffusées dans la base DVF sur ce département."
    });
  }

  if (!debug) {
    try {
      const cached = await getCache(cp);
      if (cached) return ok(H, Object.assign({ depuis_cache: true }, cached));
    } catch (e) { console.error('cache_read_error', cp, e.message); }
  }

  const diag = {};
  let result;
  try {
    result = await construire(cp, diag);
  } catch (e) {
    console.error('dvf_error', cp, e.message);
    return ok(H, debug
      ? { code_postal: cp, couvert: true, panneau: false, erreur: e.message, diag }
      : { code_postal: cp, couvert: true, panneau: false });
  }

  if (!debug && result.panneau) {
    try { await putCache(cp, result); } catch (e) { console.error('cache_write_error', cp, e.message); }
  }
  return ok(H, debug ? Object.assign({}, result, { diag }) : result);
};

// ---------------------------------------------------------------
async function construire(cp, diag) {
  const vide = { code_postal: cp, couvert: true, panneau: false };

  // 1) Communes du code postal, les plus peuplées d'abord
  const communes = await getCommunes(cp);
  diag.communes_trouvees = communes.map(c => `${c.nom} (${c.code})`);
  if (!communes.length) return vide;

  const dep = departementDeInsee(communes[0].code);

  // 2) Année de référence : la plus récente réellement publiée
  const annee = await derniereAnnee(dep, communes[0].code, diag);
  if (!annee) return vide;
  diag.annee_retenue = annee;

  // 3) Téléchargement en parallèle : année courante + année de référence
  const anneeRef = annee - ECART_TENDANCE;
  const jobs = [];
  for (const c of communes) {
    jobs.push(charger(annee,   dep, c.code, cp));
    jobs.push(charger(anneeRef, dep, c.code, cp));
  }
  const lots = await Promise.all(jobs);

  const now = [], ref = [];
  lots.forEach((rows, i) => (i % 2 === 0 ? now : ref).push(...rows));
  diag.mutations_annee = now.length;
  diag.mutations_ref   = ref.length;
  if (!now.length) return vide;

  return indicateurs(cp, annee, anneeRef, now, ref);
}

async function getCommunes(cp) {
  const r = await fetchTO(GEO_URL(cp), 4000);
  if (!r.ok) return [];
  const arr = await r.json();
  return (Array.isArray(arr) ? arr : [])
    .filter(c => c && c.code)
    .sort((a, b) => (b.population || 0) - (a.population || 0))
    .slice(0, MAX_COMMUNES);
}

// Le millésime le plus récent n'est pas publié à date fixe : on sonde.
async function derniereAnnee(dep, insee, diag) {
  const courante = new Date().getFullYear();
  const essais = [];
  for (let a = courante; a >= courante - 3; a--) {
    try {
      const r = await fetchTO(DVF_CSV(a, dep, insee), 4000, 'HEAD');
      essais.push(`${a}:${r.status}`);
      if (r.ok) { diag.sondage_annees = essais; return a; }
    } catch (e) { essais.push(`${a}:err`); }
  }
  diag.sondage_annees = essais;
  return null;
}

async function charger(annee, dep, insee, cp) {
  try {
    const r = await fetchTO(DVF_CSV(annee, dep, insee), 7000);
    if (!r.ok) return [];
    return parseCSV(await r.text(), cp);
  } catch (e) { return []; }
}

// ---------------------------------------------------------------
// Lecture CSV : on ne garde que les ventes de bâti du bon code postal,
// et on regroupe les lots d'une même mutation (surfaces additionnées).
function parseCSV(texte, cp) {
  const lignes = texte.split('\n');
  if (lignes.length < 2) return [];
  const cols = decoupe(lignes[0]);
  const I = {};
  ['id_mutation','date_mutation','nature_mutation','valeur_fonciere',
   'code_postal','nom_commune','type_local','surface_reelle_bati']
    .forEach(n => { I[n] = cols.indexOf(n); });
  if (I.valeur_fonciere < 0 || I.date_mutation < 0) return [];

  const muts = new Map();
  for (let i = 1; i < lignes.length; i++) {
    if (!lignes[i]) continue;
    const f = decoupe(lignes[i]);
    if (f.length < cols.length - 2) continue;

    if (String(f[I.code_postal] || '').trim() !== cp) continue;
    if (!String(f[I.nature_mutation] || '').toLowerCase().includes('vente')) continue;

    const type = f[I.type_local];
    if (type !== 'Maison' && type !== 'Appartement') continue;

    const val = Number(f[I.valeur_fonciere]);
    if (!Number.isFinite(val) || val < 10000 || val > 5000000) continue;

    const d = new Date(f[I.date_mutation]);
    if (isNaN(d)) continue;

    const surf = Number(f[I.surface_reelle_bati]);
    const key  = f[I.id_mutation] || `${f[I.date_mutation]}|${val}|${f[I.nom_commune]}`;

    if (!muts.has(key)) {
      muts.set(key, {
        date: d, valeur: val, type,
        commune: f[I.nom_commune] || null,
        surface: Number.isFinite(surf) ? surf : 0
      });
    } else if (Number.isFinite(surf)) {
      muts.get(key).surface += surf;   // lot supplémentaire de la même vente
    }
  }
  return [...muts.values()];
}

// Découpage CSV tolérant aux guillemets
function decoupe(ligne) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < ligne.length; i++) {
    const c = ligne[i];
    if (c === '"') { if (q && ligne[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
    else if (c === ',' && !q) { out.push(cur); cur = ''; }
    else if (c !== '\r') cur += c;
  }
  out.push(cur);
  return out;
}

// ---------------------------------------------------------------
function indicateurs(cp, annee, anneeRef, now, ref) {
  const nb = now.length;
  const valeurs = now.map(x => x.valeur).sort((a, b) => a - b);

  const out = {
    code_postal: cp,
    couvert: true,
    panneau: true,
    communes: [...new Set(now.map(x => x.commune).filter(Boolean))].sort(),
    nb_ventes: nb,
    prix_median: nb >= VOL_MIN_MEDIANE ? quantile(valeurs, 0.5) : null,
    periode: `sur l'année ${annee}`,
    annee_donnees: annee,
    source: 'base DVF, DGFiP'
  };

  if (nb >= VOL_MIN_MEDIANE) {
    out.prix_p25 = quantile(valeurs, 0.25);
    out.prix_p75 = quantile(valeurs, 0.75);
    out.part_maisons = Math.round(now.filter(x => x.type === 'Maison').length / nb * 100);
  }

  const m2 = now.filter(x => x.surface >= 9 && x.surface <= 600)
                .map(x => Math.round(x.valeur / x.surface))
                .filter(v => v >= 200 && v <= 25000)
                .sort((a, b) => a - b);
  if (m2.length >= VOL_MIN_M2) out.prix_m2_median = quantile(m2, 0.5);

  if (nb >= VOL_MIN_TENDANCE && ref.length >= VOL_MIN_TENDANCE) {
    const vRef = ref.map(x => x.valeur).sort((a, b) => a - b);
    const mRef = quantile(vRef, 0.5), mNow = quantile(valeurs, 0.5);
    if (mRef && mNow) {
      out.annee_ref = anneeRef;
      out.evolution_prix_pct   = Math.round((mNow - mRef) / mRef * 100);
      out.evolution_volume_pct = Math.round((nb - ref.length) / ref.length * 100);
    }
  }

  const voisines = parCommune(now, out.communes);
  if (voisines.length) out.voisines = voisines;

  return out;
}

function parCommune(rows, communes) {
  if (!communes || communes.length < 2) return [];
  const m = new Map();
  for (const x of rows) {
    if (!x.commune) continue;
    if (!m.has(x.commune)) m.set(x.commune, []);
    m.get(x.commune).push(x.valeur);
  }
  const entries = [...m.entries()].sort((a, b) => b[1].length - a[1].length);
  const principale = entries[0][0];
  return entries
    .filter(([nom, v]) => nom !== principale && v.length >= VOL_MIN_MEDIANE)
    .slice(0, 3)
    .map(([nom, v]) => ({ nom, prix_median: quantile(v.sort((a, b) => a - b), 0.5) }));
}

// ---------------------------------------------------------------
function ok(H, obj) { return { statusCode: 200, headers: H, body: JSON.stringify(obj) }; }

function zoneNonCouverte(cp) {
  return ['57', '67', '68'].includes(cp.slice(0, 2)) || cp.slice(0, 3) === '976';
}

function departementDeInsee(insee) {
  return /^(2A|2B)/.test(insee) ? insee.slice(0, 2)
       : insee.slice(0, 2) === '97' ? insee.slice(0, 3)
       : insee.slice(0, 2);
}

async function fetchTO(url, ms, method) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { signal: ctrl.signal, method: method || 'GET' }); }
  finally { clearTimeout(t); }
}

function quantile(sorted, p) {
  const n = sorted.length;
  if (!n) return null;
  if (n === 1) return Math.round(sorted[0]);
  const pos = (n - 1) * p, lo = Math.floor(pos), hi = Math.ceil(pos);
  return Math.round(sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo));
}

// ---------------------------------------------------------------
function supaHeaders() { return { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` }; }

async function getCache(cp) {
  const r = await fetch(
    `${SUPA_URL}/rest/v1/${CACHE_TABLE}?code_postal=eq.${cp}&select=payload,updated_at`,
    { headers: supaHeaders() });
  if (!r.ok) return null;
  const rows = await r.json();
  if (!rows.length || !rows[0].payload) return null;
  const ageDays = (Date.now() - new Date(rows[0].updated_at).getTime()) / 86400000;
  return ageDays > CACHE_TTL_DAYS ? null : rows[0].payload;
}

async function putCache(cp, payload) {
  await fetch(`${SUPA_URL}/rest/v1/${CACHE_TABLE}?on_conflict=code_postal`, {
    method: 'POST',
    headers: Object.assign(supaHeaders(), {
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates'
    }),
    body: JSON.stringify([{
      code_postal: cp,
      couvert:     payload.couvert !== false,
      communes:    payload.communes || null,
      nb_ventes:   payload.nb_ventes ?? null,
      prix_median: payload.prix_median ?? null,
      periode:     payload.periode || null,
      payload,
      updated_at:  new Date().toISOString()
    }])
  });
}

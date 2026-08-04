// ============================================================
// IMMOLEAD · Fonction serverless "Données marché DVF"
// Emplacement : netlify/functions/market.js
// Appel front : /.netlify/functions/market?cp=61450&r=30
// Diagnostic  : /.netlify/functions/market?cp=61450&r=30&debug=1
//
// PÉRIMÈTRE : toutes les communes situées dans un rayon de r km
// autour de la commune du code postal, DANS SON DÉPARTEMENT.
// Un agent proche d'une limite départementale voit donc un
// secteur tronqué — c'est annoncé explicitement côté front.
//
// SOURCES (officielles) :
//   geo.api.gouv.fr        -> communes + coordonnées
//   files.data.gouv.fr     -> DVF géolocalisées, 1 CSV.gz par département
// ============================================================

const zlib = require('zlib');

const SUPA_URL       = process.env.SUPABASE_URL;
const SUPA_KEY       = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CACHE_TABLE    = 'market_data_cache';
const CACHE_TTL_DAYS = 30;

const RAYONS_OK      = [10, 20, 30, 50];
const ECART_TENDANCE = 3;
const VOL_MIN_MEDIANE  = 20;
const VOL_MIN_M2       = 30;
const VOL_MIN_TENDANCE = 40;
const VOL_MIN_PART     = 25;   // part de marché : en dessous, ratio peu significatif

const GEO_CP  = cp  => `https://geo.api.gouv.fr/communes?codePostal=${cp}&fields=code,nom,centre,population&format=json`;
const GEO_DEP = dep => `https://geo.api.gouv.fr/departements/${dep}/communes?fields=code,nom,centre&format=json`;
const DVF_DEP = (annee, dep) => `https://files.data.gouv.fr/geo-dvf/latest/csv/${annee}/departements/${dep}.csv.gz`;

exports.handler = async (event) => {
  const H  = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
  const q  = event.queryStringParameters || {};
  const cp = (q.cp || '').trim();
  const debug = q.debug === '1';
  let rayon = parseInt(q.r, 10);
  if (RAYONS_OK.indexOf(rayon) < 0) rayon = 30;

  if (!/^\d{5}$/.test(cp)) {
    return { statusCode: 400, headers: H, body: JSON.stringify({ error: 'code_postal invalide' }) };
  }

  if (zoneNonCouverte(cp)) {
    return ok(H, {
      code_postal: cp, rayon_km: rayon, couvert: false, panneau: false,
      message: "Transactions non diffusées dans la base DVF sur ce département."
    });
  }

  const cle = `${cp}-${rayon}`;
  if (!debug) {
    try {
      const cached = await getCache(cle);
      if (cached) return ok(H, Object.assign({ depuis_cache: true }, cached));
    } catch (e) { console.error('cache_read_error', cle, e.message); }
  }

  const diag = {};
  let result;
  try {
    result = await construire(cp, rayon, diag);
  } catch (e) {
    console.error('dvf_error', cle, e.message);
    return ok(H, debug
      ? { code_postal: cp, rayon_km: rayon, couvert: true, panneau: false, erreur: e.message, diag }
      : { code_postal: cp, rayon_km: rayon, couvert: true, panneau: false });
  }

  if (!debug && result.panneau) {
    try { await putCache(cle, result); } catch (e) { console.error('cache_write_error', cle, e.message); }
  }
  return ok(H, debug ? Object.assign({}, result, { diag }) : result);
};

// ---------------------------------------------------------------
async function construire(cp, rayon, diag) {
  const vide = { code_postal: cp, rayon_km: rayon, couvert: true, panneau: false };

  // 1) Commune du code postal (la plus peuplée si plusieurs) + son centre
  const rCp = await fetchTO(GEO_CP(cp), 4000);
  if (!rCp.ok) return vide;
  const listeCp = await rCp.json();
  if (!Array.isArray(listeCp) || !listeCp.length) return vide;
  const centre = listeCp
    .filter(c => c && c.centre && c.centre.coordinates)
    .sort((a, b) => (b.population || 0) - (a.population || 0))[0];
  if (!centre) return vide;

  const [lon0, lat0] = centre.centre.coordinates;
  const dep = departementDeInsee(centre.code);
  diag.commune_centre = `${centre.nom} (${centre.code})`;
  diag.departement = dep;

  // 2) Communes du département dans le rayon
  const rDep = await fetchTO(GEO_DEP(dep), 5000);
  if (!rDep.ok) return vide;
  const toutes = await rDep.json();
  const dansRayon = new Map();
  for (const c of (Array.isArray(toutes) ? toutes : [])) {
    if (!c || !c.centre || !c.centre.coordinates) continue;
    const [lon, lat] = c.centre.coordinates;
    if (distanceKm(lat0, lon0, lat, lon) <= rayon) dansRayon.set(c.code, c.nom);
  }
  if (!dansRayon.size) dansRayon.set(centre.code, centre.nom);
  diag.communes_dans_rayon = dansRayon.size;

  // 3) Millésime le plus récent publié
  const annee = await derniereAnnee(dep, diag);
  if (!annee) return vide;
  const anneeRef = annee - ECART_TENDANCE;

  // 4) Un seul fichier départemental par année, en parallèle
  const [now, ref] = await Promise.all([
    chargerDep(annee,    dep, dansRayon, diag, 'ms_annee'),
    chargerDep(anneeRef, dep, dansRayon, diag, 'ms_ref').catch(() => [])
  ]);
  diag.mutations_annee = now.length;
  diag.mutations_ref   = ref.length;
  if (!now.length) return vide;

  return indicateurs(cp, rayon, centre.nom, dansRayon.size, annee, anneeRef, now, ref);
}

async function derniereAnnee(dep, diag) {
  const courante = new Date().getFullYear();
  const essais = [];
  for (let a = courante; a >= courante - 3; a--) {
    try {
      const r = await fetchTO(DVF_DEP(a, dep), 4000, 'HEAD');
      essais.push(`${a}:${r.status}`);
      if (r.ok) { diag.sondage_annees = essais; diag.annee_retenue = a; return a; }
    } catch (e) { essais.push(`${a}:err`); }
  }
  diag.sondage_annees = essais;
  return null;
}

async function chargerDep(annee, dep, communes, diag, cleMs) {
  const t0 = Date.now();
  const r = await fetchTO(DVF_DEP(annee, dep), 9000);
  if (!r.ok) return [];
  const brut = Buffer.from(await r.arrayBuffer());
  const texte = zlib.gunzipSync(brut).toString('utf8');
  if (diag) { diag[cleMs] = Date.now() - t0; diag[cleMs + '_ko'] = Math.round(brut.length / 1024); }
  return parseCSV(texte, communes);
}

// ---------------------------------------------------------------
function parseCSV(texte, communes) {
  const lignes = texte.split('\n');
  if (lignes.length < 2) return [];
  const cols = decoupe(lignes[0]);
  const I = {};
  ['id_mutation','date_mutation','nature_mutation','valeur_fonciere',
   'code_commune','nom_commune','type_local','surface_reelle_bati']
    .forEach(n => { I[n] = cols.indexOf(n); });
  if (I.valeur_fonciere < 0 || I.date_mutation < 0 || I.code_commune < 0) return [];

  const muts = new Map();
  for (let i = 1; i < lignes.length; i++) {
    const L = lignes[i];
    if (!L) continue;
    const f = decoupe(L);

    const insee = String(f[I.code_commune] || '').trim();
    if (!communes.has(insee)) continue;

    const type = f[I.type_local];
    if (type !== 'Maison' && type !== 'Appartement') continue;
    if (!String(f[I.nature_mutation] || '').toLowerCase().includes('vente')) continue;

    const val = Number(f[I.valeur_fonciere]);
    if (!Number.isFinite(val) || val < 10000 || val > 5000000) continue;

    const d = new Date(f[I.date_mutation]);
    if (isNaN(d)) continue;

    const surf = Number(f[I.surface_reelle_bati]);
    const key  = f[I.id_mutation] || `${f[I.date_mutation]}|${val}|${insee}`;

    if (!muts.has(key)) {
      muts.set(key, {
        date: d, valeur: val, type,
        commune: f[I.nom_commune] || communes.get(insee) || null,
        surface: Number.isFinite(surf) ? surf : 0
      });
    } else if (Number.isFinite(surf)) {
      muts.get(key).surface += surf;
    }
  }
  return [...muts.values()];
}

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
function indicateurs(cp, rayon, communeCentre, nbCommunes, annee, anneeRef, now, ref) {
  const nb = now.length;
  const valeurs = now.map(x => x.valeur).sort((a, b) => a - b);

  const out = {
    code_postal: cp,
    rayon_km: rayon,
    commune_centre: communeCentre,
    nb_communes: nbCommunes,
    couvert: true,
    panneau: true,
    nb_ventes: nb,
    prix_median: nb >= VOL_MIN_MEDIANE ? quantile(valeurs, 0.5) : null,
    periode: `sur l'année ${annee}`,
    annee_donnees: annee,
    part_marche_possible: nb >= VOL_MIN_PART,
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

  // Tendance : mêmes mois des deux côtés (le dernier millésime peut être partiel)
  const moisMax = Math.max.apply(null, now.map(x => x.date.getMonth()));
  out.mois_couverts = moisMax + 1;
  const nowC = now.filter(x => x.date.getMonth() <= moisMax);
  const refC = ref.filter(x => x.date.getMonth() <= moisMax);
  if (nowC.length >= VOL_MIN_TENDANCE && refC.length >= VOL_MIN_TENDANCE) {
    const mRef = quantile(refC.map(x => x.valeur).sort((a, b) => a - b), 0.5);
    const mNow = quantile(nowC.map(x => x.valeur).sort((a, b) => a - b), 0.5);
    if (mRef && mNow) {
      out.annee_ref = anneeRef;
      out.evolution_prix_pct   = Math.round((mNow - mRef) / mRef * 100);
      out.evolution_volume_pct = Math.round((nowC.length - refC.length) / refC.length * 100);
    }
  }

  const villes = parCommune(now);
  if (villes.length) out.voisines = villes;

  return out;
}

// Communes du secteur les plus actives, hors commune centre
function parCommune(rows) {
  const m = new Map();
  for (const x of rows) {
    if (!x.commune) continue;
    if (!m.has(x.commune)) m.set(x.commune, []);
    m.get(x.commune).push(x.valeur);
  }
  const e = [...m.entries()].sort((a, b) => b[1].length - a[1].length);
  if (e.length < 2) return [];
  return e.slice(1, 4)
    .filter(([, v]) => v.length >= VOL_MIN_MEDIANE)
    .map(([nom, v]) => ({ nom, prix_median: quantile(v.sort((a, b) => a - b), 0.5) }));
}

// ---------------------------------------------------------------
function distanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

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

async function getCache(cle) {
  const r = await fetch(
    `${SUPA_URL}/rest/v1/${CACHE_TABLE}?code_postal=eq.${encodeURIComponent(cle)}&select=payload,updated_at`,
    { headers: supaHeaders() });
  if (!r.ok) return null;
  const rows = await r.json();
  if (!rows.length || !rows[0].payload) return null;
  const ageDays = (Date.now() - new Date(rows[0].updated_at).getTime()) / 86400000;
  return ageDays > CACHE_TTL_DAYS ? null : rows[0].payload;
}

async function putCache(cle, payload) {
  await fetch(`${SUPA_URL}/rest/v1/${CACHE_TABLE}?on_conflict=code_postal`, {
    method: 'POST',
    headers: Object.assign(supaHeaders(), {
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates'
    }),
    body: JSON.stringify([{
      code_postal: cle,
      couvert:     payload.couvert !== false,
      communes:    payload.voisines || null,
      nb_ventes:   payload.nb_ventes ?? null,
      prix_median: payload.prix_median ?? null,
      periode:     payload.periode || null,
      payload,
      updated_at:  new Date().toISOString()
    }])
  });
}

/* =====================================================================
   INFOS LÉGALES IMMOLEAD
   Modifie UNIQUEMENT les valeurs entre guillemets ci-dessous.
   Elles se remplissent automatiquement dans les 3 pages légales
   (mentions légales, CGV, politique de confidentialité).
   ===================================================================== */
window.IMMOLEAD_INFOS = {
  forme:        "EURL",                              // forme juridique
  capital:      "1 000",                             // capital social (sans le €)
  siege:        "40, Rue Vivienne, 75002, Paris",       // siège social
  rcsVille:     "Paris",                             // RCS — ex : Thionville
  siren:        "994 567 121",                        // n° SIREN
  tva:          "En cours d'attribution",            // TVA intracommunautaire
  email:        "contact@immolead.net",              // email de contact
  telephone:    "06 25 35 44 43",                    // téléphone
  directeur:    "LEJOSNE Simon",                     // directeur de la publication
  hebergeur:    "Netlify, Inc., 512 2nd Street, Suite 200, San Francisco, CA 94107, États-Unis",
  preavis:      "30",                                // préavis de résiliation (jours)
  conservation: "3 ans"                              // durée de conservation des données
};

/* --- Ne rien modifier en dessous : remplit automatiquement les pages --- */
document.addEventListener("DOMContentLoaded", function () {
  var I = window.IMMOLEAD_INFOS || {};
  document.querySelectorAll("[data-info]").forEach(function (el) {
    var k = el.getAttribute("data-info");
    if (I[k]) el.textContent = I[k];
  });
});

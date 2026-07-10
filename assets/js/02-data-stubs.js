
/* ============================================================
   OSI data layer
   ------------------------------------------------------------
   The DAT / treasury datasets (corporate SOL-treasury registry
   and the treasury case studies) were removed. OSI is now a
   single, case-first on-chain forensic product. Real cases come
   from user submissions via Supabase; published findings render
   in Latest Intelligence and Case Studies as they are added.

   These two globals are intentionally kept (empty) so that
   app.js references stay valid and every render guards cleanly.
   The previous treasury dataset is preserved in data_local.js
   for reference and is no longer deployed.
   ============================================================ */

window.TREASURY_DATA = { companies: [] };

window.CASE_STUDIES = [];


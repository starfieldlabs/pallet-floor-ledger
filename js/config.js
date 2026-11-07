/*
 * Pallet Floor Ledger — where shared shop data is kept.
 *
 * Both empty: the app keeps everything on this device only, and the demo works
 * with no sign-in.
 * Filled in: people sign in and a shop's data is the same on every device.
 *
 * The publishable key is meant to be public. What each person can see and
 * change is decided by the access rules in supabase/schema.sql, not by hiding
 * this key. Never put a secret or service_role key here.
 */
window.PFL_CONFIG = {
  // Supabase project "pallet-floor-ledger" (organization starfieldlabs, us-east-1)
  supabaseUrl: 'https://lchpbmpyvacdvwexyafc.supabase.co',
  supabaseKey: 'sb_publishable_HMBSRdh29g5CJ9NaOO4qEQ_OJVsvSW9'
};

// The site's timezone, in one place.
//
// Read from the environment rather than inlined so the server, the browser and
// the Python workers all name the same zone — see shared/analyticsConfig.ts and
// models/*/pipeline/schedule.py, which must agree with this or a client is told
// a feature is armed while the worker thinks it is not.
export function getAppTimezoneName(): string {
  return process.env.APP_TIMEZONE || "Asia/Kolkata";
}

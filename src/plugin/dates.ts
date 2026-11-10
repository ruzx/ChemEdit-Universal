// Date helpers (local time) — no dependency on the global moment instance.
const p2 = (n: number) => String(n).padStart(2, "0");
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const LONG_DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** YYYY-MM-DD */
export const isoDate = (d = new Date()) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
/** YYYYMMDD_HHmmss */
export const fileStamp = (d = new Date()) => `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}_${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
/** HH:mm */
export const nowHM = (d = new Date()) => `${p2(d.getHours())}:${p2(d.getMinutes())}`;
/** DD.MM.YYYY (Ddd) — lab-book day stamp */
export const dateStamp = (d = new Date()) => `${p2(d.getDate())}.${p2(d.getMonth() + 1)}.${d.getFullYear()} (${DAYS[d.getDay()]})`;
/** Monday, 3 November 2026 */
export const longDate = (d = new Date()) => `${LONG_DAYS[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
/** today + n years as YYYY-MM-DD */
export const inYears = (n: number) => { const d = new Date(); d.setFullYear(d.getFullYear() + n); return isoDate(d); };

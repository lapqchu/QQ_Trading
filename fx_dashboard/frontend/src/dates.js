// Date utilities — ported from v1

export function thirdWed(y, m) {
  const d = new Date(y, m, 1);
  const dow = d.getDay();
  const fw = dow <= 3 ? (3 - dow + 1) : (10 - dow + 1);
  return new Date(y, m, fw + 14);
}
export function daysBtwn(a, b) { return Math.round((b - a) / 864e5); }
export function addMon(base, m) {
  const d = new Date(base);
  d.setMonth(d.getMonth() + m);
  if (d.getDay() === 6) d.setDate(d.getDate() + 2);
  if (d.getDay() === 0) d.setDate(d.getDate() + 1);
  return d;
}
export function bizBefore(dt, n) {
  const d = new Date(dt);
  let c = 0;
  while (c < n) { d.setDate(d.getDate() - 1); if (d.getDay() !== 0 && d.getDay() !== 6) c++; }
  return d;
}
export function dateFromSpot(spotDate, days) {
  const d = new Date(spotDate.getTime() + days * 864e5);
  if (d.getDay() === 6) d.setDate(d.getDate() + 2);
  if (d.getDay() === 0) d.setDate(d.getDate() + 1);
  return d;
}
const MN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function fD(d) { return d ? `${String(d.getDate()).padStart(2, "0")}-${MN[d.getMonth()]}-${String(d.getFullYear()).slice(2)}` : "—"; }

export function buildIMMDates(spotDate) {
  const dates = [];
  const y = spotDate.getFullYear();
  for (let yr = y; yr <= y + 2; yr++) {
    for (const mo of [2, 5, 8, 11]) {
      const tw = thirdWed(yr, mo);
      const days = daysBtwn(spotDate, tw);
      if (days > 0 && days < 800) dates.push({ label: `IMM ${MN[mo]}${String(yr).slice(2)}`, valDate: tw, days });
    }
  }
  return dates.sort((a, b) => a.days - b.days);
}

export function buildTenorDates(spotDate) {
  const d = {};
  for (let m = 0; m <= 24; m++) {
    const vd = m === 0 ? spotDate : addMon(spotDate, m);
    d[m] = { valDate: vd, fixDate: bizBefore(vd, 2) };
  }
  return d;
}

// Compute spotDate as T+2 business days from today
export function computeSpotDate(today) {
  if (!today) today = new Date();
  const d = new Date(today);
  let c = 0;
  while (c < 2) { d.setDate(d.getDate() + 1); if (d.getDay() !== 0 && d.getDay() !== 6) c++; }
  return d;
}

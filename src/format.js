const colorEnabled = process.stdout.isTTY && !process.env.NO_COLOR;

const wrap = (code) => (s) => (colorEnabled ? `\x1b[${code}m${s}\x1b[0m` : String(s));

export const bold = wrap('1');
export const dim = wrap('2');
export const red = wrap('31');
export const green = wrap('32');
export const yellow = wrap('33');
export const magenta = wrap('35');
export const cyan = wrap('36');

export function ago(unixSeconds) {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - unixSeconds);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

export function clock(date = new Date()) {
  return date.toTimeString().slice(0, 8);
}

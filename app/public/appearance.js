export const DEFAULT_APPEARANCE = Object.freeze({ accent:'#52765b', backgroundColor:'#f6f7f3', backgroundImage:'', backgroundOpacity:18, companionAvatar:'', userAvatar:'' });
export const THEMES = [
  { name:'森系绿', accent:'#52765b', backgroundColor:'#f6f7f3' },
  { name:'雾海蓝', accent:'#406d91', backgroundColor:'#f0f5fa' },
  { name:'落日玫', accent:'#a6506b', backgroundColor:'#fcf2f5' },
  { name:'柔雾紫', accent:'#78619c', backgroundColor:'#f6f3fb' },
  { name:'暖杏茶', accent:'#926639', backgroundColor:'#faf5eb' }
];
export function validImage(value, max = 1600000) {
  if (value === '') return true;
  if (typeof value !== 'string' || value.length > max) return false;
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match || match[2].length % 4 !== 0) return false;
  try {
    const raw = atob(match[2]);
    if (match[1] === 'png') return raw.startsWith('\x89PNG\r\n\x1a\n');
    if (match[1] === 'jpeg') return raw.startsWith('\xff\xd8\xff');
    return raw.startsWith('RIFF') && raw.slice(8,12) === 'WEBP';
  } catch { return false; }
}
export function validAppearance(a) {
  return !!a && typeof a === 'object' && ['accent','backgroundColor'].every(k => /^#[0-9a-fA-F]{6}$/.test(a[k])) &&
    Number.isInteger(a.backgroundOpacity) && a.backgroundOpacity >= 0 && a.backgroundOpacity <= 60 &&
    validImage(a.backgroundImage) && validImage(a.companionAvatar,240000) && validImage(a.userAvatar,240000);
}
export function cleanAppearance(a) {
  if (!validAppearance(a)) throw new Error('外观设置格式不正确，请重新选择颜色或图片。');
  return Object.fromEntries(Object.keys(DEFAULT_APPEARANCE).map(k => [k,a[k]]));
}
export function contrastText(hex) {
  const rgb = [1,3,5].map(i => { const v = parseInt(hex.slice(i,i+2),16)/255; return v <= .04045 ? v/12.92 : ((v+.055)/1.055)**2.4; });
  return .2126*rgb[0]+.7152*rgb[1]+.0722*rgb[2] > .179 ? '#17251d' : '#ffffff';
}
export function themeProperties(a) {
  return { '--green':a.accent, '--accent':a.accent, '--accent-text':contrastText(a.accent), '--bg':a.backgroundColor,
    '--background-text':contrastText(a.backgroundColor), '--wallpaper':a.backgroundImage ? `url("${a.backgroundImage}")` : 'none', '--wallpaper-opacity':String(a.backgroundOpacity/100) };
}

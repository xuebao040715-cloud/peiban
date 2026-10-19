// 模型参数：服务端与前端共用的默认值、范围与校验。
export const DEFAULT_OPTIONS = Object.freeze({ temperature: 0.8, numPredict: 500, numCtx: 8192 });
export const OPTION_LIMITS = Object.freeze({ temperature: [0, 2], numPredict: [64, 4000], numCtx: [2048, 32768] });
export function validOptions(o) {
  return !!o && typeof o === 'object' && !Array.isArray(o) &&
    Number.isFinite(o.temperature) && o.temperature >= OPTION_LIMITS.temperature[0] && o.temperature <= OPTION_LIMITS.temperature[1] &&
    Number.isInteger(o.numPredict) && o.numPredict >= OPTION_LIMITS.numPredict[0] && o.numPredict <= OPTION_LIMITS.numPredict[1] &&
    Number.isInteger(o.numCtx) && o.numCtx >= OPTION_LIMITS.numCtx[0] && o.numCtx <= OPTION_LIMITS.numCtx[1];
}
export function cleanOptions(o) {
  if (!validOptions(o)) throw new Error('模型参数超出允许范围，请重新调整。');
  return { temperature: o.temperature, numPredict: o.numPredict, numCtx: o.numCtx };
}
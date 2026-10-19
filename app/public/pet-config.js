// 桌宠配置：服务端校验与前端默认值共用。
export const DEFAULT_PET = Object.freeze({ enabled: false, intervalMinutes: 5, size: 'medium', alwaysOnTop: true, model: '' });
export const PET_SIZES = Object.freeze(['small', 'medium', 'large']);
export function validPet(pet) {
  return !!pet && typeof pet === 'object' && !Array.isArray(pet) &&
    typeof pet.enabled === 'boolean' && typeof pet.alwaysOnTop === 'boolean' &&
    Number.isInteger(pet.intervalMinutes) && pet.intervalMinutes >= 1 && pet.intervalMinutes <= 60 &&
    PET_SIZES.includes(pet.size) &&
    typeof pet.model === 'string' && pet.model.length <= 100;
}
export function cleanPet(pet) {
  if (!validPet(pet)) throw new Error('桌宠设置格式不正确。');
  return { enabled: pet.enabled, intervalMinutes: pet.intervalMinutes, size: pet.size, alwaysOnTop: pet.alwaysOnTop, model: pet.model };
}

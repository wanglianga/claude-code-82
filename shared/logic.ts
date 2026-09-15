import type { BookingKind, MemberTier } from './types.js';

// ============ 水质标准（人工游泳场所卫生限值，平台演示口径） ============
export const WATER_STD = {
  temp: { min: 26, max: 28, label: '水温', unit: '°C' },
  chlorine: { min: 0.3, max: 1.0, label: '余氯', unit: 'mg/L' },
  turbidity: { max: 1.0, label: '浊度', unit: 'NTU' },
  ph: { min: 7.0, max: 7.8, label: 'pH', unit: '' },
};

export function evaluateWater(r: { tempC: number; freeChlorine: number; turbidity: number; ph: number }) {
  const fields: string[] = [];
  if (r.tempC < WATER_STD.temp.min || r.tempC > WATER_STD.temp.max)
    fields.push(`水温 ${r.tempC}°C 超出 ${WATER_STD.temp.min}-${WATER_STD.temp.max}°C`);
  if (r.freeChlorine < WATER_STD.chlorine.min || r.freeChlorine > WATER_STD.chlorine.max)
    fields.push(`余氯 ${r.freeChlorine}mg/L 超出 ${WATER_STD.chlorine.min}-${WATER_STD.chlorine.max}mg/L`);
  if (r.turbidity > WATER_STD.turbidity.max)
    fields.push(`浊度 ${r.turbidity}NTU 高于 ${WATER_STD.turbidity.max}NTU`);
  if (r.ph < WATER_STD.ph.min || r.ph > WATER_STD.ph.max)
    fields.push(`pH ${r.ph} 超出 ${WATER_STD.ph.min}-${WATER_STD.ph.max}`);
  return { abnormal: fields.length > 0, fields };
}

// ============ 计价 ============
export function priceOf(kind: BookingKind, partySize: number, childCount: number, _tier?: MemberTier, lessonPrice?: number) {
  switch (kind) {
    case 'elder_morning': return 0;
    case 'parent_child': return 30 + 10 * childCount;
    case 'guest': return 45;
    case 'personal': return 25;
    case 'group': return 20 * Math.max(partySize, 1);
    case 'institution_rental': return Math.max(300, 15 * Math.max(partySize, 1));
    case 'coaching': return lessonPrice ?? 120;
  }
}

// Catalogue facts used by best fit (P-26) and the comparison table (P-30). Templates are defined by SkyUp, so a
// fact is found by its feature key first and its name second (document change 35 asks SkyUp to keep these keys).
import type { FeatureValue, ProductData } from '../catalogue/productData.js';
import { displayValue } from '../catalogue/productData.js';
import type { Feature } from '../catalogue/types.service.js';

export type Role = 'roomRent' | 'coPay' | 'pedWait' | 'restore' | 'csr' | 'network';
const KEYS: Record<Role, { keys: string[]; name: RegExp }> = {
  roomRent: { keys: ['room_rent', 'room_rent_limit'], name: /room\s*rent/i },
  coPay: { keys: ['copay', 'co_pay'], name: /co-?\s*pay/i },
  pedWait: { keys: ['ped_wait', 'pre_existing_waiting', 'ped_waiting_period'], name: /pre-?\s*existing/i },
  restore: { keys: ['restore', 'restore_benefit'], name: /restor/i },
  csr: { keys: ['csr', 'claim_settlement_ratio'], name: /claim\s*settlement/i },
  network: { keys: ['network', 'network_hospitals'], name: /network/i },
};
export const ROLE_LABELS: Record<Role, string> = {
  roomRent: 'Room rent',
  coPay: 'Co-pay',
  pedWait: 'Pre-existing disease waiting period',
  restore: 'Restore benefit',
  csr: 'Claim settlement ratio',
  network: 'Network hospitals',
};

export function findFeature(features: Feature[], role: Role): Feature | undefined {
  const k = KEYS[role];
  return features.find((f) => k.keys.includes(f.key)) ?? features.find((f) => k.name.test(f.name));
}

export function fact(features: Feature[], data: ProductData, role: Role): { feature: Feature | undefined; value: FeatureValue | undefined; text: string } {
  const feature = findFeature(features, role);
  const value = feature ? data.features[feature.key] : undefined;
  const text = feature ? (displayValue(feature, value) ?? 'Not stated by insurer') : 'Not stated by insurer';
  return { feature, value, text: value && !value.notStated && value.value !== null ? text : 'Not stated by insurer' };
}

/** Feature keys already shown in the fixed comparison rows. */
export function roleKeys(features: Feature[]): Set<string> {
  return new Set((Object.keys(KEYS) as Role[]).map((r) => findFeature(features, r)?.key).filter((k): k is string => !!k));
}

import { CREDIT_CONTROL_AREA_CAPABILITY } from '@/platform/auth/capability-policy';

export const CREDIT_CONTROL_AREA_ACTIVITY = CREDIT_CONTROL_AREA_CAPABILITY;
export const CREDIT_CONTROL_AREA_LOCKS = {
  area: 'CREDIT_CONTROL_AREA',
  company: 'COMPANY_CODE_CREDIT_AREA',
} as const;

/** The approved implementation defaults; currency is derived from the selected Company Code. */
export const CREDIT_CONTROL_AREA_DEFAULTS = {
  creditControlArea: '0001',
  name: 'Standard credit control area',
  warningThresholdPercent: 90,
  isActive: true,
} as const;

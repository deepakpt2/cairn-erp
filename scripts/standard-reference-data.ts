/** Authoritative built-in global reference definitions and safe initialization. */
import type { Sql } from 'postgres';
import { PARTNER_BANK_PROFILE_POLICIES } from '../src/platform/security/partner-bank-profile-readiness';

export const COUNTRIES: Array<[string, string, string]> = [
  ['KW', 'Kuwait', 'KWD'], ['SA', 'Saudi Arabia', 'SAR'], ['AE', 'United Arab Emirates', 'AED'],
  ['BH', 'Bahrain', 'BHD'], ['QA', 'Qatar', 'QAR'], ['OM', 'Oman', 'OMR'],
  ['JO', 'Jordan', 'JOD'], ['EG', 'Egypt', 'EGP'], ['LB', 'Lebanon', 'LBP'],
  ['US', 'United States', 'USD'], ['GB', 'United Kingdom', 'GBP'], ['DE', 'Germany', 'EUR'],
  ['FR', 'France', 'EUR'], ['IT', 'Italy', 'EUR'], ['ES', 'Spain', 'EUR'],
  ['NL', 'Netherlands', 'EUR'], ['CH', 'Switzerland', 'CHF'], ['SE', 'Sweden', 'SEK'],
  ['IN', 'India', 'INR'], ['CN', 'China', 'CNY'], ['JP', 'Japan', 'JPY'],
  ['KR', 'South Korea', 'KRW'], ['SG', 'Singapore', 'SGD'], ['MY', 'Malaysia', 'MYR'],
  ['TR', 'Türkiye', 'TRY'], ['ZA', 'South Africa', 'ZAR'], ['AU', 'Australia', 'AUD'],
  ['CA', 'Canada', 'CAD'], ['BR', 'Brazil', 'BRL'], ['MX', 'Mexico', 'MXN'],
];

// Third value is decimal places — this matters for rounding, not decoration.
export const CURRENCIES: Array<[string, string, number, string | null]> = [
  ['USD', 'US Dollar', 2, '$'], ['EUR', 'Euro', 2, '\u20ac'], ['GBP', 'Pound Sterling', 2, '\u00a3'],
  ['KWD', 'Kuwaiti Dinar', 3, 'KD'], ['SAR', 'Saudi Riyal', 2, 'SR'], ['AED', 'UAE Dirham', 2, 'AED'],
  ['BHD', 'Bahraini Dinar', 3, 'BD'], ['QAR', 'Qatari Riyal', 2, 'QR'], ['OMR', 'Omani Rial', 3, 'OMR'],
  ['JOD', 'Jordanian Dinar', 3, 'JD'], ['EGP', 'Egyptian Pound', 2, 'E\u00a3'], ['LBP', 'Lebanese Pound', 2, 'L\u00a3'],
  ['CHF', 'Swiss Franc', 2, 'CHF'], ['SEK', 'Swedish Krona', 2, 'kr'], ['JPY', 'Japanese Yen', 0, '\u00a5'],
  ['CNY', 'Chinese Yuan', 2, '\u00a5'], ['INR', 'Indian Rupee', 2, '\u20b9'], ['KRW', 'South Korean Won', 0, '\u20a9'],
  ['SGD', 'Singapore Dollar', 2, 'S$'], ['MYR', 'Malaysian Ringgit', 2, 'RM'], ['TRY', 'Turkish Lira', 2, '\u20ba'],
  ['ZAR', 'South African Rand', 2, 'R'], ['AUD', 'Australian Dollar', 2, 'A$'], ['CAD', 'Canadian Dollar', 2, 'C$'],
  ['BRL', 'Brazilian Real', 2, 'R$'], ['MXN', 'Mexican Peso', 2, 'MX$'],
];

export const UNITS: Array<[string, string, string, number, boolean]> = [
  // code, name, dimension, decimals, isBaseUnit
  ['PC', 'Piece', 'COUNT', 0, true], ['EA', 'Each', 'COUNT', 0, false],
  ['BOX', 'Box', 'COUNT', 0, false], ['SET', 'Set', 'COUNT', 0, false],
  ['KG', 'Kilogram', 'MASS', 3, true], ['G', 'Gram', 'MASS', 3, false],
  ['T', 'Tonne', 'MASS', 3, false], ['LB', 'Pound', 'MASS', 3, false],
  ['M', 'Metre', 'LENGTH', 3, true], ['CM', 'Centimetre', 'LENGTH', 3, false],
  ['MM', 'Millimetre', 'LENGTH', 3, false], ['FT', 'Foot', 'LENGTH', 3, false],
  ['L', 'Litre', 'VOLUME', 3, true], ['ML', 'Millilitre', 'VOLUME', 3, false],
  ['M3', 'Cubic metre', 'VOLUME', 3, false], ['GAL', 'Gallon', 'VOLUME', 3, false],
  ['HR', 'Hour', 'TIME', 2, true], ['MIN', 'Minute', 'TIME', 2, false],
  ['DAY', 'Day', 'TIME', 0, false],
  ['M2', 'Square metre', 'AREA', 3, true], ['KWH', 'Kilowatt hour', 'ENERGY', 3, true],
];

/**
 * Insert only missing standard rows. Existing customer-maintained values are
 * deliberately left untouched. The caller owns the transaction so tests and
 * the provisioning command can use the same atomic operation.
 */
type ReferenceDataExecutor = Pick<Sql, 'unsafe'>;

export async function insertStandardReferenceData(client: ReferenceDataExecutor): Promise<void> {
  for (const [code, name, decimals, symbol] of CURRENCIES) {
    await client.unsafe(
      `insert into currency (code, name, decimal_places, symbol) values ($1,$2,$3,$4)
       on conflict (code) do nothing`,
      [code, name, decimals, symbol],
    );
  }

  for (const [code, name, defaultCurrency] of COUNTRIES) {
    await client.unsafe(
      `insert into country (code, name, default_currency) values ($1,$2,$3)
       on conflict (code) do nothing`,
      [code, name, defaultCurrency],
    );
  }

  for (const [code, name, dimension, decimals, isBase] of UNITS) {
    await client.unsafe(
      `insert into unit_of_measure (code, name, dimension, decimal_places, is_base_unit)
       values ($1,$2,$3,$4,$5)
       on conflict (code) do nothing`,
      [code, name, dimension, decimals, isBase],
    );
  }

  for (const { country, policyRevision } of PARTNER_BANK_PROFILE_POLICIES) {
    await client.unsafe(
      `insert into partner_bank_country_profile
         (country_code, policy_revision, readiness_status, created_by)
       values ($1, $2, 'NOT_READY', 'SYSTEM')
       on conflict (country_code) do nothing`,
      [country, policyRevision],
    );
  }
}

/** Atomic, repeatable provisioning step used after migrations and before tenant seeding. */
export async function initializeStandardReferenceData(client: Sql): Promise<void> {
  await client.begin((tx) => insertStandardReferenceData(tx));
}

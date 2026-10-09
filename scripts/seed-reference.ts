/**
 * Global reference data — countries, currencies, units of measure.
 *
 * Not tenant-scoped: the same everywhere, read-only through the application,
 * maintained here. A representative set rather than every ISO code — enough for
 * the standard configuration and for realistic GCC and international trade,
 * and extending it is additive.
 */
import postgres from 'postgres';

const COUNTRIES: Array<[string, string, string]> = [
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
const CURRENCIES: Array<[string, string, number, string | null]> = [
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

const UNITS: Array<[string, string, string, number, boolean]> = [
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

async function main() {
  const connectionString =
    process.env.MIGRATION_DATABASE_URL ?? 'postgresql://cairn:cairn_dev@127.0.0.1:5432/cairn';
  const client = postgres(connectionString, { max: 1, prepare: false, onnotice: () => {} });

  try {
    for (const [code, name, defaultCurrency] of COUNTRIES) {
      await client.unsafe(
        `insert into country (code, name, default_currency) values ($1,$2,$3)
         on conflict (code) do update set name = excluded.name, default_currency = excluded.default_currency`,
        [code, name, defaultCurrency],
      );
    }

    for (const [code, name, decimals, symbol] of CURRENCIES) {
      await client.unsafe(
        `insert into currency (code, name, decimal_places, symbol) values ($1,$2,$3,$4)
         on conflict (code) do update set name = excluded.name, decimal_places = excluded.decimal_places, symbol = excluded.symbol`,
        [code, name, decimals, symbol],
      );
    }

    for (const [code, name, dimension, decimals, isBase] of UNITS) {
      await client.unsafe(
        `insert into unit_of_measure (code, name, dimension, decimal_places, is_base_unit)
         values ($1,$2,$3,$4,$5)
         on conflict (code) do update set name = excluded.name, dimension = excluded.dimension`,
        [code, name, dimension, decimals, isBase],
      );
    }

    const counts = await client.unsafe(`
      select 'country' as t, count(*)::text as n from country
      union all select 'currency', count(*)::text from currency
      union all select 'unit_of_measure', count(*)::text from unit_of_measure
    `);
    console.log('Reference data seeded:', counts);
  } finally {
    await client.end({ timeout: 5 });
  }
}

main().catch((error) => {
  console.error('Seed failed:', error.message);
  process.exit(1);
});

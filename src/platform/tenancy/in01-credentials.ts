/**
 * The credential report for the India UAT dataset.
 *
 * One row per account, each with its own generated password, because the point of the dataset is
 * that a tester can sign in as each role and see what segregation of duties actually does. A
 * single shared password would make the roles indistinguishable in practice.
 *
 * The report is written to a mode-0600 file, and the same rows are served by the in-app view at
 * `/platform/users/test-credentials`, which refuses outside development.
 *
 * The passwords live only here and in the app's memory for the run that generated them. They are
 * never written to the database: the database holds a one-way hash, as it does for any account.
 */

export interface In01CredentialRow {
  username: string;
  /** The generated test password. Test-only, and labelled as such wherever it is shown. */
  password: string;
  role: string;
  employee: string;
  personnelNumber: string | null;
  department: string;
}

export interface RenderIn01CredentialsInput {
  company: string;
  clientKey: string;
  companyCode: string;
  loginUrl: string;
  accounts: In01CredentialRow[];
  filePath: string;
  generatedAt: string;
  until: string;
}

const RULE = '='.repeat(94);
const THIN = '-'.repeat(94);

/**
 * The credential file.
 *
 * The warning comes first because it is the part that must not be missed: these are real
 * accounts with generated passwords in a fictional company, and the one thing worse than losing
 * them is treating the environment they open as somewhere to keep real books.
 */
export function renderIn01CredentialReport(input: RenderIn01CredentialsInput): string {
  let out = '';
  out += `${RULE}\n`;
  out += '  CAIRN — INDIA UAT CREDENTIALS — TEST ONLY\n';
  out += `${RULE}\n\n`;
  out += '  This environment contains FICTIONAL DATA ONLY. Every company, person,\n';
  out += '  vendor, customer, PAN, GSTIN and bank account in it is invented.\n\n';
  out += '  Every account below has its OWN password, generated at install time.\n';
  out += '  They are TEST CREDENTIALS. Do not reuse them anywhere, and do not put\n';
  out += '  real business data into this environment.\n\n';

  out += `${THIN}\n`;
  out += `  Company      ${input.company}\n`;
  out += `  Company code ${input.companyCode}     Tenant ${input.clientKey}\n`;
  out += `  Login URL    ${input.loginUrl}\n`;
  out += `  Installed    ${input.until}     Generated ${input.generatedAt}\n`;
  out += `${THIN}\n`;
  out += '  ACCOUNTS\n';
  out += `${THIN}\n`;

  const widths = {
    username: Math.max(...input.accounts.map((row) => row.username.length), 'USERNAME'.length),
    password: Math.max(...input.accounts.map((row) => row.password.length), 'PASSWORD'.length),
    role: Math.max(...input.accounts.map((row) => row.role.length), 'ROLE'.length),
    department: Math.max(...input.accounts.map((row) => row.department.length), 'DEPARTMENT'.length),
  };

  out += `  ${'USERNAME'.padEnd(widths.username)}  ${'PASSWORD'.padEnd(widths.password)}  `
    + `${'ROLE'.padEnd(widths.role)}  ${'DEPARTMENT'.padEnd(widths.department)}  EMPLOYEE\n`;
  out += `  ${'-'.repeat(widths.username)}  ${'-'.repeat(widths.password)}  `
    + `${'-'.repeat(widths.role)}  ${'-'.repeat(widths.department)}  ${'-'.repeat(20)}\n`;

  for (const row of input.accounts) {
    out += `  ${row.username.padEnd(widths.username)}  ${row.password.padEnd(widths.password)}  `
      + `${row.role.padEnd(widths.role)}  ${row.department.padEnd(widths.department)}  `
      + `${row.employee}${row.personnelNumber ? ` (${row.personnelNumber})` : ''}\n`;
  }

  out += `${THIN}\n`;
  out += '  These are test credentials. The in-app view of this list is disabled\n';
  out += '  outside a development build, and the credential file is not committed\n';
  out += '  to Git, not copied into the image, and readable only by its owner.\n';
  out += `${THIN}\n`;
  out += `  File         ${input.filePath}\n`;
  out += `${RULE}\n`;
  return out;
}

/** A machine-readable export of the same rows, for whoever wants them in a spreadsheet. */
export function renderIn01CredentialCsv(rows: In01CredentialRow[]): string {
  const escape = (value: string) => `"${value.replace(/"/g, '""')}"`;
  const header = ['username', 'password', 'role', 'employee', 'personnelNumber', 'department'];
  const lines = [header.join(',')];
  for (const row of rows) {
    lines.push([
      escape(row.username), escape(row.password), escape(row.role),
      escape(row.employee), escape(row.personnelNumber ?? ''), escape(row.department),
    ].join(','));
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Table index. Modules contribute their tables by re-exporting them here,
 * which is how src/platform/schema.ts and Drizzle both find them (§20.3).
 */
export * from './tenancy';
export * from './security';
export * from './numbering';
export * from './lock';
export * from './audit-trail';
export * from './registry';
export * from './system';
export * from './reference';

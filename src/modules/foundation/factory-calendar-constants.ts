/** DB-free constants shared with client components (importing factory-calendar.ts there pulls in postgres). */
export const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;
export type Weekday = (typeof WEEKDAYS)[number];
export type WeekdayFlags = Record<Weekday, boolean>;

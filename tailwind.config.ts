import type { Config } from 'tailwindcss';

/**
 * Cairn design tokens — CAIRN.md §19.2
 *
 * Deliberately not a corporate grey-blue. Warm neutral base, one deep accent,
 * flat surfaces and sharp edges, numbers in tabular figures so columns align.
 * The density is high because ERP users read rows, not cards.
 */
export default {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        paper: '#F7F5F1',
        surface: '#FFFFFF',
        sunken: '#F1EEE8',
        line: '#E2DED6',
        'line-strong': '#CFC9BE',
        ink: '#1B1917',
        'ink-soft': '#5E5852',
        // Was #8C857C: 3.65:1 on surface and 3.35:1 on paper, below the 4.5:1
        // threshold for normal text. Darkened to 5.37:1 and 4.93:1.
        'ink-faint': '#6F6A62',
        accent: {
          DEFAULT: '#0E5C55',
          hover: '#0A4A44',
          soft: '#E7F0EE',
          line: '#B9D3CF',
        },
        signal: {
          warn: '#B45309',
          'warn-soft': '#FDF3E3',
          error: '#A32B21',
          'error-soft': '#FBEDEB',
          ok: '#2F6B3A',
          'ok-soft': '#EAF2EA',
          info: '#2C5A7A',
          'info-soft': '#EAF0F5',
        },
      },
      fontFamily: {
        sans: [
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          'Segoe UI',
          'Roboto',
          'Helvetica Neue',
          'Arial',
          'sans-serif',
        ],
        mono: [
          'ui-monospace',
          'SFMono-Regular',
          'Menlo',
          'Consolas',
          'Liberation Mono',
          'monospace',
        ],
      },
      fontSize: {
        // Compact by default — §19.2. In rem (px equivalents at a 16px
        // root) so type scales with the reader's font-size setting
        // instead of standing fixed.
        '2xs': ['0.6875rem', { lineHeight: '0.9375rem' }],
        xs: ['0.75rem', { lineHeight: '1.0625rem' }],
        sm: ['0.8125rem', { lineHeight: '1.1875rem' }],
        base: ['0.875rem', { lineHeight: '1.3125rem' }],
        lg: ['0.9375rem', { lineHeight: '1.375rem' }],
        xl: ['1.125rem', { lineHeight: '1.5rem' }],
        '2xl': ['1.375rem', { lineHeight: '1.75rem' }],
      },
      borderRadius: {
        // Near-square edges (3-4px) — flat, not pill-shaped.
        none: '0',
        sm: '0.125rem',
        DEFAULT: '0.1875rem',
        md: '0.25rem',
      },
    },
  },
  plugins: [],
} satisfies Config;

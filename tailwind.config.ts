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
        'ink-faint': '#8C857C',
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
        // Compact by default — §19.2
        '2xs': ['10.5px', { lineHeight: '14px' }],
        xs: ['11.5px', { lineHeight: '16px' }],
        sm: ['12.5px', { lineHeight: '18px' }],
        base: ['13.5px', { lineHeight: '20px' }],
        lg: ['15px', { lineHeight: '22px' }],
        xl: ['18px', { lineHeight: '24px' }],
        '2xl': ['22px', { lineHeight: '28px' }],
      },
      borderRadius: {
        // Sharp edges — flat, not pill-shaped.
        none: '0',
        sm: '1px',
        DEFAULT: '2px',
      },
    },
  },
  plugins: [],
} satisfies Config;

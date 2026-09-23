/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
      colors: {
        accent: {
          DEFAULT: '#1e40af', // Railway Royal Blue
          hover:   '#1d4ed8',
          light:   '#eff6ff',
          muted:   '#dbeafe',
        },
        surface:  '#ffffff',
        muted:    '#f8fafc',
        border:   '#e2e8f0',
        success:  '#059669',
        error:    '#dc2626',
        pending:  '#d97706',
      },
      fontSize: {
        // Compact scale suited to a dense data tool
        '2xs': ['0.7rem',  { lineHeight: '1rem' }],
        xs:    ['0.75rem', { lineHeight: '1.1rem' }],
        sm:    ['0.8125rem', { lineHeight: '1.25rem' }],
        base:  ['0.875rem', { lineHeight: '1.4rem' }],
        lg:    ['1rem',    { lineHeight: '1.5rem' }],
        xl:    ['1.125rem',{ lineHeight: '1.6rem' }],
      },
    },
  },
  plugins: [],
}

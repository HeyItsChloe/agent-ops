/** @type {import('tailwindcss').Config} */
// Colors reference CSS custom properties (set at runtime from
// wiki.config.generated.ts by src/lib/theme.ts) rather than literal hex
// values, so the same template renders correctly themed for every
// consuming repo without a per-repo Tailwind config edit.
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          DEFAULT: 'var(--wiki-accent)',
          hover: 'var(--wiki-accent-hover)',
          muted: 'var(--wiki-accent-muted)',
        },
        background: {
          DEFAULT: '#0f1117',
          elevated: '#1a1d27',
        },
        surface: {
          DEFAULT: 'rgba(255, 255, 255, 0.03)',
          hover: 'rgba(255, 255, 255, 0.06)',
          active: 'rgba(255, 255, 255, 0.09)',
          border: 'rgba(255, 255, 255, 0.08)',
          'border-hover': 'rgba(255, 255, 255, 0.15)',
        },
        content: {
          DEFAULT: '#ffffff',
          secondary: '#a1a1aa',
          muted: '#71717a',
        },
        status: {
          success: '#34c759',
          warning: '#f59e0b',
          error: '#ef4444',
        },
        // Pipeline-category colours for the /automation matrix (CSS vars in index.css).
        cat: {
          dev: 'var(--cat-dev)',
          ci: 'var(--cat-ci)',
          e2e: 'var(--cat-e2e)',
          email: 'var(--cat-email)',
          crawler: 'var(--cat-crawler)',
          docs: 'var(--cat-docs)',
          deploy: 'var(--cat-deploy)',
          sync: 'var(--cat-sync)',
          jobsearch: 'var(--cat-jobsearch)',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
      },
      maxWidth: {
        container: '1200px',
        'container-lg': '1400px',
        content: '760px',
      },
    },
  },
  plugins: [],
};

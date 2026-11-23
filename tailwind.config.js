/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: {
          950: '#060607', 900: '#0B0B0D', 850: '#101013', 800: '#151519', 750: '#1A1A1F',
          700: '#212127', 600: '#2C2C33', 500: '#3D3D45', 400: '#6C6C76', 300: '#9C9CA6',
          200: '#C8C8D0', 100: '#EDEDF0', 50: '#F7F7F8',
        },
        lime: { DEFAULT: '#C6F432', 300: '#DDFB7E', 400: '#D2F85A', 500: '#C6F432', 600: '#A6D615', 700: '#7EA50C' },
        brand: 'rgb(var(--brand-rgb) / <alpha-value>)',
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        display: ['Manrope', 'Inter', 'ui-sans-serif', 'sans-serif'],
      },
      boxShadow: {
        card: '0 1px 0 0 rgba(255,255,255,0.04) inset, 0 10px 30px -12px rgba(0,0,0,0.6)',
        glow: '0 0 0 1px rgba(198,244,50,0.35), 0 8px 30px -8px rgba(198,244,50,0.35)',
      },
      keyframes: {
        'fade-up': { from: { opacity: 0, transform: 'translateY(6px)' }, to: { opacity: 1, transform: 'none' } },
        'fade-in': { from: { opacity: 0 }, to: { opacity: 1 } },
        'slide-in-right': { from: { transform: 'translateX(100%)' }, to: { transform: 'none' } },
        'slide-in-up': { from: { transform: 'translateY(100%)' }, to: { transform: 'none' } },
        shimmer: { '100%': { transform: 'translateX(100%)' } },
      },
      animation: {
        'fade-up': 'fade-up .35s cubic-bezier(.2,.8,.2,1) both',
        'fade-in': 'fade-in .2s ease-out both',
        'slide-in-right': 'slide-in-right .3s cubic-bezier(.2,.8,.2,1) both',
        'slide-in-up': 'slide-in-up .3s cubic-bezier(.2,.8,.2,1) both',
      },
    },
  },
  plugins: [],
}

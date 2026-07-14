/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        'space': ['Space Grotesk', 'system-ui', 'sans-serif'],
        'jb': ['JetBrains Mono', 'monospace'],
        'inter': ['Inter', 'system-ui', 'sans-serif'],
      },
      colors: {
        'poly-purple': '#8b5cf6',
        'poly-blue': '#3b82f6',
        'poly-green': '#10b981',
        'poly-red': '#ef4444',
        'poly-yellow': '#f59e0b',
        'poly-cyan': '#06b6d4',
        'poly-pink': '#ec4899',
        'poly-orange': '#f97316',
        'poly-gray': '#1e1e2e',
        'poly-dark': '#0f0f17',
        'poly-card': '#16161e',
        'poly-border': '#2a2a3e',
      },
      backgroundImage: {
        'gradient-radial': 'radial-gradient(var(--tw-gradient-stops))',
      },
      boxShadow: {
        'glow-green': '0 0 20px rgba(16, 185, 129, 0.3)',
        'glow-red': '0 0 20px rgba(239, 68, 68, 0.3)',
        'glow-purple': '0 0 20px rgba(139, 92, 246, 0.3)',
        'glow-blue': '0 0 20px rgba(59, 130, 246, 0.3)',
        'glow-yellow': '0 0 20px rgba(245, 158, 11, 0.3)',
      },
      animation: {
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
      },
    },
  },
  plugins: [],
};

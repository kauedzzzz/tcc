#!/usr/bin/env node
/**
 * =====================================================================================
 * CuidAção — Script de Build e Automação PWA Offline-First (scripts/build.js)
 * -------------------------------------------------------------------------------------
 * 1. Compila CSS utilitário estático (Tailwind CSS local em public/css/tailwind.min.css)
 *    sem depender de CDN JIT em runtime. Usa CLI tailwindcss se instalada localmente ou
 *    o compilador estático integrado zero-dependências.
 * 2. Valida todos os caminhos declarados em SHELL_ASSETS dentro de public/sw.js.
 * 3. Calcula hash SHA-256 determinístico dos arquivos de public/ e atualiza VERSION em
 *    public/sw.js automaticamente quando houver alterações.
 * =====================================================================================
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const SW_PATH = path.join(PUBLIC_DIR, 'sw.js');
const OUT_CSS_PATH = path.join(PUBLIC_DIR, 'css', 'tailwind.min.css');

// Paleta oficial Tailwind v3 usada no projeto
const COLORS = {
  transparent: 'transparent',
  current: 'currentColor',
  black: '#000000',
  white: '#ffffff',
  slate: { 50: '#f8fafc', 100: '#f1f5f9', 200: '#e2e8f0', 300: '#cbd5e1', 400: '#94a3b8', 500: '#64748b', 600: '#475569', 700: '#334155', 800: '#1e293b', 900: '#0f172a', 950: '#020617' },
  gray: { 50: '#f9fafb', 100: '#f3f4f6', 200: '#e5e7eb', 300: '#d1d5db', 400: '#9ca3af', 500: '#6b7280', 600: '#4b5563', 700: '#374151', 800: '#1f2937', 900: '#111827', 950: '#030712' },
  red: { 50: '#fef2f2', 100: '#fee2e2', 200: '#fecaca', 300: '#fca5a5', 400: '#f87171', 500: '#ef4444', 600: '#dc2626', 700: '#b91c1c', 800: '#991b1b', 900: '#7f1d1d', 950: '#450a0a' },
  amber: { 50: '#fffbeb', 100: '#fef3c7', 200: '#fde68a', 300: '#fcd34d', 400: '#fbbf24', 500: '#f59e0b', 600: '#d97706', 700: '#b45309', 800: '#92400e', 900: '#78350f', 950: '#451a03' },
  yellow: { 50: '#fefce8', 100: '#fef9c3', 200: '#fef08a', 300: '#fde047', 400: '#facc15', 500: '#eab308', 600: '#ca8a04', 700: '#a16207', 800: '#854d0e', 900: '#713f12' },
  lime: { 100: '#ecfccb', 200: '#d9f99d', 300: '#bef264', 400: '#a3e635', 500: '#84cc16' },
  green: { 50: '#f0fdf4', 100: '#dcfce7', 200: '#bbf7d0', 500: '#22c55e', 600: '#16a34a', 700: '#15803d', 800: '#166534', 900: '#14532d' },
  emerald: { 50: '#ecfdf5', 100: '#d1fae5', 200: '#a7f3d0', 300: '#6ee7b7', 400: '#34d399', 500: '#10b981', 600: '#059669', 700: '#047857', 800: '#065f46', 900: '#064e3b', 950: '#022c22' },
  teal: { 50: '#f0fdfa', 100: '#ccfbf1', 200: '#99f6e4', 500: '#14b8a6', 600: '#0d9488', 700: '#0f766e', 800: '#115e59', 900: '#134e4a', 950: '#042f2e' },
  cyan: { 50: '#ecfeff', 100: '#cffafe', 500: '#06b6d4', 600: '#0891b2', 700: '#0e7490', 800: '#155e75' },
  blue: { 50: '#eff6ff', 100: '#dbeafe', 200: '#bfdbfe', 300: '#93c5fd', 400: '#60a5fa', 500: '#3b82f6', 600: '#2563eb', 700: '#1d4ed8', 800: '#1e40af', 900: '#1e3a8a' },
  indigo: { 50: '#eef2ff', 100: '#e0e7ff', 500: '#6366f1', 600: '#4f46e5', 700: '#4338ca' },
  violet: { 50: '#f5f3ff', 100: '#ede9fe', 500: '#8b5cf6', 600: '#7c3aed', 700: '#6d28d9', 800: '#5b21b6' },
  purple: { 50: '#faf5ff', 100: '#f3e8ff', 200: '#e9d5ff', 500: '#a855f7', 600: '#9333ea', 700: '#7e22ce', 800: '#6b21a8' },
  orange: { 50: '#fff7ed', 100: '#ffedd5', 200: '#fed7aa', 500: '#f97316', 600: '#ea580c', 700: '#c2410c', 800: '#9a3412' },
  rose: { 50: '#fff1f2', 100: '#ffe4e6', 500: '#f43f5e', 600: '#e11d48', 700: '#be123c' }
};

const SPACING = {
  '0': '0px',
  'px': '1px',
  '0.5': '0.125rem',
  '1': '0.25rem',
  '1.5': '0.375rem',
  '2': '0.5rem',
  '2.5': '0.625rem',
  '3': '0.75rem',
  '3.5': '0.875rem',
  '4': '1rem',
  '5': '1.25rem',
  '6': '1.5rem',
  '7': '1.75rem',
  '8': '2rem',
  '9': '2.25rem',
  '10': '2.5rem',
  '11': '2.75rem',
  '12': '3rem',
  '14': '3.5rem',
  '16': '4rem',
  '20': '5rem',
  '24': '6rem',
  '28': '7rem',
  '32': '8rem',
  '36': '9rem',
  '40': '10rem',
  '44': '11rem',
  '48': '12rem',
  '56': '14rem',
  '64': '16rem',
  '72': '18rem',
  '80': '20rem',
  '96': '24rem'
};

function hexToRgb(hex) {
  const clean = hex.replace('#', '');
  const n = parseInt(clean, 16);
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
}

function resolveColor(token) {
  const [namePart, alphaPart] = token.split('/');
  let hex = null;
  if (COLORS[namePart] && typeof COLORS[namePart] === 'string') {
    hex = COLORS[namePart];
  } else {
    const dashIdx = namePart.lastIndexOf('-');
    if (dashIdx > 0) {
      const family = namePart.slice(0, dashIdx);
      const shade = namePart.slice(dashIdx + 1);
      if (COLORS[family] && COLORS[family][shade]) hex = COLORS[family][shade];
    }
  }
  if (!hex) return null;
  if (!alphaPart) return hex;
  if (hex === 'transparent' || hex === 'currentColor') return hex;
  const alpha = Math.max(0, Math.min(1, parseFloat(alphaPart) / 100));
  return `rgba(${hexToRgb(hex)}, ${alpha})`;
}

function escapeSelector(cls) {
  return cls.replace(/([^a-zA-Z0-9_-])/g, '\\$1');
}

function arbitraryVal(raw) {
  if (!raw.startsWith('[') || !raw.endsWith(']')) return null;
  return raw.slice(1, -1).replace(/_/g, ' ');
}

function generateRuleDecl(base) {
  // Exact static utilities
  const exact = {
    'block': 'display:block',
    'inline-block': 'display:inline-block',
    'inline': 'display:inline',
    'flex': 'display:flex',
    'inline-flex': 'display:inline-flex',
    'grid': 'display:grid',
    'hidden': 'display:none',
    'relative': 'position:relative',
    'absolute': 'position:absolute',
    'fixed': 'position:fixed',
    'sticky': 'position:sticky',
    'inset-0': 'inset:0px',
    'flex-row': 'flex-direction:row',
    'flex-col': 'flex-direction:column',
    'flex-wrap': 'flex-wrap:wrap',
    'flex-nowrap': 'flex-wrap:nowrap',
    'flex-1': 'flex:1 1 0%',
    'flex-auto': 'flex:1 1 auto',
    'flex-grow': 'flex-grow:1',
    'grow': 'flex-grow:1',
    'flex-shrink': 'flex-shrink:1',
    'shrink-0': 'flex-shrink:0',
    'items-start': 'align-items:flex-start',
    'items-end': 'align-items:flex-end',
    'items-center': 'align-items:center',
    'items-baseline': 'align-items:baseline',
    'items-stretch': 'align-items:stretch',
    'justify-start': 'justify-content:flex-start',
    'justify-end': 'justify-content:flex-end',
    'justify-center': 'justify-content:center',
    'justify-between': 'justify-content:space-between',
    'self-auto': 'align-self:auto',
    'self-start': 'align-self:flex-start',
    'self-end': 'align-self:flex-end',
    'self-center': 'align-self:center',
    'overflow-hidden': 'overflow:hidden',
    'overflow-auto': 'overflow:auto',
    'overflow-y-auto': 'overflow-y:auto',
    'overflow-x-auto': 'overflow-x:auto',
    'w-full': 'width:100%',
    'w-screen': 'width:100vw',
    'w-auto': 'width:auto',
    'w-fit': 'width:fit-content',
    'h-full': 'height:100%',
    'h-screen': 'height:100vh',
    'h-auto': 'height:auto',
    'min-w-0': 'min-width:0px',
    'min-h-screen': 'min-height:100vh',
    'max-h-screen': 'max-height:100vh',
    'max-w-none': 'max-width:none',
    'max-w-xs': 'max-width:20rem',
    'max-w-sm': 'max-width:24rem',
    'max-w-md': 'max-width:28rem',
    'max-w-lg': 'max-width:32rem',
    'max-w-xl': 'max-width:36rem',
    'max-w-2xl': 'max-width:42rem',
    'max-w-3xl': 'max-width:48rem',
    'max-w-4xl': 'max-width:56rem',
    'max-w-5xl': 'max-width:64rem',
    'max-w-6xl': 'max-width:72rem',
    'max-w-7xl': 'max-width:80rem',
    'mx-auto': 'margin-left:auto;margin-right:auto',
    'my-auto': 'margin-top:auto;margin-bottom:auto',
    'ml-auto': 'margin-left:auto',
    'mr-auto': 'margin-right:auto',
    'font-sans': 'font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif',
    'font-mono': 'font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace',
    'font-normal': 'font-weight:400',
    'font-medium': 'font-weight:500',
    'font-semibold': 'font-weight:600',
    'font-bold': 'font-weight:700',
    'font-extrabold': 'font-weight:800',
    'font-black': 'font-weight:900',
    'italic': 'font-style:italic',
    'not-italic': 'font-style:normal',
    'antialiased': '-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale',
    'text-xs': 'font-size:0.75rem;line-height:1rem',
    'text-sm': 'font-size:0.875rem;line-height:1.25rem',
    'text-base': 'font-size:1rem;line-height:1.5rem',
    'text-lg': 'font-size:1.125rem;line-height:1.75rem',
    'text-xl': 'font-size:1.25rem;line-height:1.75rem',
    'text-2xl': 'font-size:1.5rem;line-height:2rem',
    'text-3xl': 'font-size:1.875rem;line-height:2.25rem',
    'text-4xl': 'font-size:2.25rem;line-height:2.5rem',
    'leading-none': 'line-height:1',
    'leading-tight': 'line-height:1.25',
    'leading-snug': 'line-height:1.375',
    'leading-normal': 'line-height:1.5',
    'leading-relaxed': 'line-height:1.625',
    'tracking-tight': 'letter-spacing:-0.025em',
    'tracking-normal': 'letter-spacing:0em',
    'tracking-wide': 'letter-spacing:0.025em',
    'tracking-wider': 'letter-spacing:0.05em',
    'tracking-widest': 'letter-spacing:0.1em',
    'text-left': 'text-align:left',
    'text-center': 'text-align:center',
    'text-right': 'text-align:right',
    'uppercase': 'text-transform:uppercase',
    'lowercase': 'text-transform:lowercase',
    'capitalize': 'text-transform:capitalize',
    'underline': 'text-decoration-line:underline',
    'no-underline': 'text-decoration-line:none',
    'underline-offset-4': 'text-underline-offset:4px',
    'truncate': 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap',
    'whitespace-nowrap': 'white-space:nowrap',
    'whitespace-pre-wrap': 'white-space:pre-wrap',
    'break-words': 'overflow-wrap:break-word',
    'line-clamp-2': 'overflow:hidden;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2',
    'select-none': 'user-select:none;-webkit-user-select:none',
    'select-text': 'user-select:text;-webkit-user-select:text',
    'pointer-events-none': 'pointer-events:none',
    'pointer-events-auto': 'pointer-events:auto',
    'cursor-pointer': 'cursor:pointer',
    'cursor-default': 'cursor:default',
    'cursor-not-allowed': 'cursor:not-allowed',
    'rounded': 'border-radius:0.25rem',
    'rounded-none': 'border-radius:0px',
    'rounded-sm': 'border-radius:0.125rem',
    'rounded-md': 'border-radius:0.375rem',
    'rounded-lg': 'border-radius:0.5rem',
    'rounded-xl': 'border-radius:0.75rem',
    'rounded-2xl': 'border-radius:1rem',
    'rounded-3xl': 'border-radius:1.5rem',
    'rounded-full': 'border-radius:9999px',
    'rounded-t-3xl': 'border-top-left-radius:1.5rem;border-top-right-radius:1.5rem',
    'border': 'border-width:1px',
    'border-0': 'border-width:0px',
    'border-2': 'border-width:2px',
    'border-4': 'border-width:4px',
    'border-t': 'border-top-width:1px',
    'border-b': 'border-bottom-width:1px',
    'border-l': 'border-left-width:1px',
    'border-r': 'border-right-width:1px',
    'border-t-0': 'border-top-width:0px',
    'border-b-2': 'border-bottom-width:2px',
    'border-r-2': 'border-right-width:2px',
    'border-l-4': 'border-left-width:4px',
    'border-dashed': 'border-style:dashed',
    'outline-none': 'outline:2px solid transparent;outline-offset:2px',
    'ring-1': 'box-shadow:0 0 0 1px var(--tw-ring-color, rgba(16,185,129,0.5))',
    'ring-2': 'box-shadow:0 0 0 2px var(--tw-ring-color, rgba(16,185,129,0.5))',
    'ring-4': 'box-shadow:0 0 0 4px var(--tw-ring-color, rgba(16,185,129,0.4))',
    'shadow-sm': 'box-shadow:0 1px 2px 0 rgba(0,0,0,0.05)',
    'shadow': 'box-shadow:0 1px 3px 0 rgba(0,0,0,0.1),0 1px 2px -1px rgba(0,0,0,0.1)',
    'shadow-md': 'box-shadow:0 4px 6px -1px rgba(0,0,0,0.1),0 2px 4px -2px rgba(0,0,0,0.1)',
    'shadow-lg': 'box-shadow:0 10px 15px -3px rgba(0,0,0,0.12),0 4px 6px -4px rgba(0,0,0,0.1)',
    'shadow-xl': 'box-shadow:0 20px 25px -5px rgba(0,0,0,0.12),0 8px 10px -6px rgba(0,0,0,0.1)',
    'shadow-2xl': 'box-shadow:0 25px 50px -12px rgba(0,0,0,0.28)',
    'shadow-none': 'box-shadow:none',
    'backdrop-blur-sm': 'backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px)',
    'backdrop-blur': 'backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px)',
    'backdrop-blur-md': 'backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px)',
    'backdrop-blur-lg': 'backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px)',
    'transition': 'transition-property:color,background-color,border-color,text-decoration-color,fill,stroke,opacity,box-shadow,transform,filter,backdrop-filter;transition-timing-function:cubic-bezier(0.4,0,0.2,1);transition-duration:150ms',
    'transition-all': 'transition-property:all;transition-timing-function:cubic-bezier(0.4,0,0.2,1);transition-duration:150ms',
    'transition-colors': 'transition-property:color,background-color,border-color;transition-timing-function:cubic-bezier(0.4,0,0.2,1);transition-duration:150ms',
    'transition-opacity': 'transition-property:opacity;transition-timing-function:cubic-bezier(0.4,0,0.2,1);transition-duration:150ms',
    'transition-transform': 'transition-property:transform;transition-timing-function:cubic-bezier(0.4,0,0.2,1);transition-duration:150ms',
    'duration-150': 'transition-duration:150ms',
    'duration-200': 'transition-duration:200ms',
    'duration-300': 'transition-duration:300ms',
    'duration-500': 'transition-duration:500ms',
    'rotate-45': 'transform:rotate(45deg)',
    '-translate-x-1/2': 'transform:translateX(-50%)',
    '-translate-y-1/2': 'transform:translateY(-50%)',
    'scale-90': 'transform:scale(0.9)',
    'scale-95': 'transform:scale(0.95)',
    'scale-100': 'transform:scale(1)',
    'scale-105': 'transform:scale(1.05)',
    'scale-110': 'transform:scale(1.1)',
    'scale-125': 'transform:scale(1.25)',
    'animate-spin': 'animation:tw-spin 1s linear infinite',
    'animate-pulse': 'animation:tw-pulse 2s cubic-bezier(0.4,0,0.6,1) infinite',
    'bg-gradient-to-b': 'background-image:linear-gradient(to bottom, var(--tw-gradient-stops))',
    'bg-gradient-to-r': 'background-image:linear-gradient(to right, var(--tw-gradient-stops))',
    'bg-gradient-to-br': 'background-image:linear-gradient(to bottom right, var(--tw-gradient-stops))',
    'object-cover': 'object-fit:cover',
    'object-contain': 'object-fit:contain',
    'aspect-video': 'aspect-ratio:16 / 9',
    'tabular-nums': 'font-variant-numeric:tabular-nums'
  };
  if (exact[base]) return exact[base];

  // Grid columns & spans
  let m = base.match(/^grid-cols-(\d+)$/);
  if (m) return `grid-template-columns:repeat(${m[1]}, minmax(0, 1fr))`;
  m = base.match(/^col-span-(\d+)$/);
  if (m) return `grid-column:span ${m[1]} / span ${m[1]}`;
  m = base.match(/^order-(\d+)$/);
  if (m) return `order:${m[1]}`;

  // Z-index
  m = base.match(/^(-?)z-(\d+|auto|\[.+\])$/);
  if (m) {
    const sign = m[1];
    const val = arbitraryVal(m[2]) || m[2];
    return `z-index:${sign}${val}`;
  }

  // Opacity
  m = base.match(/^opacity-(\d+)$/);
  if (m) return `opacity:${parseInt(m[1], 10) / 100}`;

  // Positioning (top, right, bottom, left)
  m = base.match(/^(-?)(top|right|bottom|left)-(.+)$/);
  if (m) {
    const sign = m[1];
    const prop = m[2];
    const key = m[3];
    if (key === 'auto') return `${prop}:auto`;
    if (key === '1/2') return `${prop}:${sign}50%`;
    if (key === 'full') return `${prop}:${sign}100%`;
    const v = arbitraryVal(key) || SPACING[key];
    if (v) return `${prop}:${sign}${v}`;
  }

  // Gap
  m = base.match(/^gap-(x-|y-)?(.+)$/);
  if (m) {
    const axis = m[1];
    const v = arbitraryVal(m[2]) || SPACING[m[2]];
    if (v) {
      if (axis === 'x-') return `column-gap:${v}`;
      if (axis === 'y-') return `row-gap:${v}`;
      return `gap:${v}`;
    }
  }

  // Padding & Margin
  m = base.match(/^(-?)(p|m)(x|y|t|r|b|l)?-(.+)$/);
  if (m) {
    const neg = m[1] === '-' ? '-' : '';
    const kind = m[2] === 'p' ? 'padding' : 'margin';
    const dir = m[3] || '';
    const raw = m[4];
    const v = raw === 'auto' ? 'auto' : (arbitraryVal(raw) || SPACING[raw]);
    if (v) {
      const val = v === 'auto' ? 'auto' : `${neg}${v}`;
      if (!dir) return `${kind}:${val}`;
      if (dir === 'x') return `${kind}-left:${val};${kind}-right:${val}`;
      if (dir === 'y') return `${kind}-top:${val};${kind}-bottom:${val}`;
      const mapDir = { t: 'top', r: 'right', b: 'bottom', l: 'left' };
      return `${kind}-${mapDir[dir]}:${val}`;
    }
  }

  // Width / Height / Min / Max
  m = base.match(/^(w|h|min-w|max-w|min-h|max-h)-(.+)$/);
  if (m) {
    const propMap = { 'w': 'width', 'h': 'height', 'min-w': 'min-width', 'max-w': 'max-width', 'min-h': 'min-height', 'max-h': 'max-height' };
    const prop = propMap[m[1]];
    const raw = m[2];
    const fracMatch = raw.match(/^(\d+)\/(\d+)$/);
    if (fracMatch) return `${prop}:${(parseInt(fracMatch[1], 10) / parseInt(fracMatch[2], 10)) * 100}%`;
    const v = arbitraryVal(raw) || SPACING[raw];
    if (v) return `${prop}:${v}`;
  }

  // Arbitrary text size, scale, shadow
  m = base.match(/^text-(\[.+\])$/);
  if (m) return `font-size:${arbitraryVal(m[1])}`;
  m = base.match(/^scale-(\[.+\])$/);
  if (m) return `transform:scale(${arbitraryVal(m[1])})`;
  m = base.match(/^shadow-(\[.+\])$/);
  if (m) return `box-shadow:${arbitraryVal(m[1])}`;

  // Colors: bg-*, text-*, border-*, ring-*, placeholder-*
  if (base.startsWith('bg-')) {
    const c = resolveColor(base.slice(3));
    if (c) return `background-color:${c}`;
  }
  if (base.startsWith('text-')) {
    const c = resolveColor(base.slice(5));
    if (c) return `color:${c}`;
  }
  if (base.startsWith('border-')) {
    const c = resolveColor(base.slice(7));
    if (c) return `border-color:${c}`;
  }
  if (base.startsWith('ring-')) {
    const c = resolveColor(base.slice(5));
    if (c) return `--tw-ring-color:${c}`;
  }
  if (base.startsWith('from-')) {
    const c = resolveColor(base.slice(5));
    if (c) return `--tw-gradient-from:${c};--tw-gradient-to:rgba(255,255,255,0);--tw-gradient-stops:var(--tw-gradient-from),var(--tw-gradient-to)`;
  }
  if (base.startsWith('via-')) {
    const c = resolveColor(base.slice(4));
    if (c) return `--tw-gradient-stops:var(--tw-gradient-from),${c},var(--tw-gradient-to)`;
  }
  if (base.startsWith('to-')) {
    const c = resolveColor(base.slice(3));
    if (c) return `--tw-gradient-to:${c}`;
  }

  return null;
}

function collectClassCandidates(dir, out = new Set()) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === 'vendor' || ent.name === 'icons' || ent.name === 'images') continue;
      collectClassCandidates(full, out);
    } else if (ent.isFile() && /\.(html|js)$/i.test(ent.name) && ent.name !== 'sw.js') {
      const content = fs.readFileSync(full, 'utf8');
      const tokens = content.match(/[A-Za-z0-9_:/.\-[\]%(),#-]+/g) || [];
      for (const tok of tokens) {
        if (tok.length >= 1 && tok.length <= 90) out.add(tok);
      }
    }
  }
  return out;
}

function compileStaticTailwind() {
  const localTailwindBin = path.join(ROOT_DIR, 'node_modules', '.bin', 'tailwindcss');
  const localConfig = path.join(ROOT_DIR, 'tailwind.config.js');
  if (fs.existsSync(localTailwindBin) && fs.existsSync(localConfig)) {
    const res = spawnSync(localTailwindBin, ['-o', OUT_CSS_PATH, '--minify'], { cwd: ROOT_DIR, stdio: 'inherit' });
    if (res.status === 0) return 'tailwindcss-cli';
  }

  const candidates = collectClassCandidates(PUBLIC_DIR);
  const preflight = [
    '*,::before,::after{box-sizing:border-box;border-width:0;border-style:solid;border-color:#e5e7eb}',
    'html{line-height:1.5;-webkit-text-size-adjust:100%;tab-size:4;font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}',
    'body{margin:0;line-height:inherit}',
    'hr{height:0;color:inherit;border-top-width:1px}',
    'h1,h2,h3,h4,h5,h6{font-size:inherit;font-weight:inherit;margin:0}',
    'a{color:inherit;text-decoration:inherit}',
    'b,strong{font-weight:bolder}',
    'button,input,optgroup,select,textarea{font-family:inherit;font-feature-settings:inherit;font-variation-settings:inherit;font-size:100%;font-weight:inherit;line-height:inherit;color:inherit;margin:0;padding:0}',
    'button,select{text-transform:none}',
    'button,[type="button"],[type="reset"],[type="submit"]{-webkit-appearance:button;background-color:transparent;background-image:none;cursor:pointer}',
    'p,blockquote,dl,dd,figure,pre{margin:0}',
    'fieldset{margin:0;padding:0}',
    'ol,ul,menu{list-style:none;margin:0;padding:0}',
    'textarea{resize:vertical}',
    'input::placeholder,textarea::placeholder{opacity:1;color:#9ca3af}',
    'img,svg,video,canvas{display:block;vertical-align:middle}',
    'img,video{max-width:100%;height:auto}',
    '[hidden]{display:none!important}',
    '@keyframes tw-spin{to{transform:rotate(360deg)}}',
    '@keyframes tw-pulse{50%{opacity:.5}}'
  ];

  const baseRules = [];
  const mediaBuckets = {
    xs: [], // 420px
    sm: [], // 640px
    md: [], // 768px
    lg: [], // 1024px
    xl: []  // 1280px
  };

  const sorted = Array.from(candidates).sort();
  for (const token of sorted) {
    // Handle space-y-* and space-x-*
    const spaceMatch = token.match(/^(?:(xs|sm|md|lg|xl):)?space-(x|y)-(.+)$/);
    if (spaceMatch) {
      const bp = spaceMatch[1];
      const axis = spaceMatch[2];
      const val = SPACING[spaceMatch[3]];
      if (val) {
        const sel = `.${escapeSelector(token)} > :not([hidden]) ~ :not([hidden])`;
        const decl = axis === 'y' ? `margin-top:${val}` : `margin-left:${val}`;
        const rule = `${sel}{${decl}}`;
        if (bp) mediaBuckets[bp].push(rule);
        else baseRules.push(rule);
      }
      continue;
    }

    // Placeholder color
    const phMatch = token.match(/^placeholder-(.+)$/);
    if (phMatch) {
      const c = resolveColor(phMatch[1]);
      if (c) baseRules.push(`.${escapeSelector(token)}::placeholder{color:${c}}`);
      continue;
    }

    // Parse prefixes (responsive + state)
    const parts = token.split(':');
    let bp = null;
    let pseudo = '';
    let groupHover = false;
    let validPrefix = true;
    const base = parts[parts.length - 1];

    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts[i];
      if (mediaBuckets[p]) bp = p;
      else if (p === 'hover') pseudo += ':hover';
      else if (p === 'focus') pseudo += ':focus';
      else if (p === 'focus-within') pseudo += ':focus-within';
      else if (p === 'focus-visible') pseudo += ':focus-visible';
      else if (p === 'active') pseudo += ':active';
      else if (p === 'disabled') pseudo += ':disabled';
      else if (p === 'group-hover') groupHover = true;
      else { validPrefix = false; break; }
    }
    if (!validPrefix) continue;

    const decl = generateRuleDecl(base);
    if (!decl) continue;

    const escaped = escapeSelector(token);
    const selector = groupHover ? `.group:hover .${escaped}${pseudo}` : `.${escaped}${pseudo}`;
    const rule = `${selector}{${decl}}`;
    if (bp) mediaBuckets[bp].push(rule);
    else baseRules.push(rule);
  }

  const bpWidths = { xs: '420px', sm: '640px', md: '768px', lg: '1024px', xl: '1280px' };
  const mediaCss = Object.entries(bpWidths)
    .filter(([k]) => mediaBuckets[k].length > 0)
    .map(([k, minW]) => `@media (min-width:${minW}){${mediaBuckets[k].join('')}}`);

  const finalCss = `/* CuidAção Static Utility CSS (Offline-First PWA Build) */\n` +
    preflight.join('') +
    baseRules.join('') +
    mediaCss.join('') + '\n';

  fs.mkdirSync(path.dirname(OUT_CSS_PATH), { recursive: true });
  fs.writeFileSync(OUT_CSS_PATH, finalCss, 'utf8');
  return `static-compiler (${baseRules.length} rules)`;
}

function parseShellAssets(swContent) {
  const match = swContent.match(/const\s+SHELL_ASSETS\s*=\s*\[([\s\S]*?)\];/);
  if (!match) {
    throw new Error('Array SHELL_ASSETS não encontrado em public/sw.js');
  }
  const items = [];
  const strRe = /['"]([^'"]+)['"]/g;
  let m;
  while ((m = strRe.exec(match[1])) !== null) {
    items.push(m[1]);
  }
  return items;
}

function validateShellAssets(swContent) {
  const assets = parseShellAssets(swContent);
  const missing = [];
  for (const raw of assets) {
    const cleanRel = raw.split('?')[0].split('#')[0];
    if (cleanRel === './' || cleanRel === '/') {
      const idx = path.join(PUBLIC_DIR, 'index.html');
      if (!fs.existsSync(idx)) missing.push(raw);
      continue;
    }
    const target = path.resolve(PUBLIC_DIR, cleanRel.replace(/^\//, ''));
    if (!target.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
      missing.push(raw);
    }
  }
  if (missing.length > 0) {
    throw new Error('Assets ausentes em SHELL_ASSETS (public/sw.js): ' + missing.join(', '));
  }
  return assets.length;
}

function computePublicHash() {
  const hash = crypto.createHash('sha256');
  function walk(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      const rel = path.relative(PUBLIC_DIR, full).replace(/\\/g, '/');
      if (rel === 'sw.js') continue;
      if (ent.isDirectory()) {
        walk(full);
      } else if (ent.isFile()) {
        hash.update(rel + '\0');
        hash.update(fs.readFileSync(full));
      }
    }
  }
  walk(PUBLIC_DIR);
  return hash.digest('hex').slice(0, 10);
}

function updateSwVersion(newHash) {
  const swContent = fs.readFileSync(SW_PATH, 'utf8');
  const assetCount = validateShellAssets(swContent);
  const nextVersion = `v7-${newHash}`;
  const updated = swContent.replace(/const\s+VERSION\s*=\s*['"][^'"]+['"]\s*;/, `const VERSION = '${nextVersion}';`);
  const changed = updated !== swContent;
  if (changed) {
    fs.writeFileSync(SW_PATH, updated, 'utf8');
  }
  return { nextVersion, assetCount, changed };
}

function runBuild() {
  const mode = compileStaticTailwind();
  const hash = computePublicHash();
  const swInfo = updateSwVersion(hash);
  console.log(`✅ Build concluído [${mode}] • SHELL_ASSETS validados: ${swInfo.assetCount} • SW VERSION: ${swInfo.nextVersion}${swInfo.changed ? ' (atualizado)' : ' (já atual)'}`);
  return { mode, ...swInfo };
}

if (require.main === module) {
  try {
    runBuild();
  } catch (err) {
    console.error('❌ Falha no build:', err.message);
    process.exit(1);
  }
}

module.exports = { runBuild, validateShellAssets, computePublicHash };

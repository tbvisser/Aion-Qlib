/**
 * Brand configuration — driven by VITE_BRAND env var.
 * Defaults to "aion". Set VITE_BRAND=mercer-hartwell for demo.
 */

interface BrandConfig {
  name: string
  logo: string
  logoDark: string
  icon: string
  iconDark: string
}

const brands: Record<string, BrandConfig> = {
  'aion': {
    name: 'AION Partners',
    logo: '/brands/aion/logo.svg',
    logoDark: '/brands/aion/logo-darkmode.svg',
    icon: '/brands/aion/icon.svg',
    iconDark: '/brands/aion/icon-darkmode.svg',
  },
  'mercer-hartwell': {
    name: 'Mercer & Hartwell LLP',
    logo: '/brands/mercer-hartwell/logo.svg',
    logoDark: '/brands/mercer-hartwell/logo-darkmode.svg',
    icon: '/icon.svg',
    iconDark: '/icon-darkmode.svg',
  },
}

const brandKey = import.meta.env.VITE_BRAND || 'aion'

export const brand: BrandConfig = brands[brandKey] ?? brands['aion']

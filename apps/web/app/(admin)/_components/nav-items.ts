import {
  Building2,
  ClipboardList,
  FileChartColumn,
  Globe,
  LayoutDashboard,
  ListChecks,
  Receipt,
  Settings2,
  TriangleAlert,
  Users,
  type LucideIcon,
} from 'lucide-react';

export interface AdminNavItem {
  label: string;
  href: string;
  icon: LucideIcon;
}

// Admin sections + lucide mappings per docs/spec/15-brand-design-system.md.
// Sentence case everywhere (spec 15, voice).
export const adminNavItems: AdminNavItem[] = [
  { label: 'Dashboard', href: '/admin', icon: LayoutDashboard },
  { label: 'Orders', href: '/admin/orders', icon: ClipboardList },
  { label: 'Clients', href: '/admin/clients', icon: Building2 },
  { label: 'Respondents', href: '/admin/respondents', icon: Users },
  { label: 'Questionnaires', href: '/admin/questionnaires', icon: ListChecks },
  { label: 'Reports', href: '/admin/reports', icon: FileChartColumn },
  { label: 'Billing', href: '/admin/billing', icon: Receipt },
  { label: 'Domains', href: '/admin/domains', icon: Globe },
  { label: 'Error queue', href: '/admin/errors', icon: TriangleAlert },
  { label: 'Settings', href: '/admin/settings', icon: Settings2 },
];

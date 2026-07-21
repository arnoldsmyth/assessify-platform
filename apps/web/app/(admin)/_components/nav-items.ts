import {
  Building2,
  ClipboardList,
  FileChartColumn,
  Globe,
  Landmark,
  LayoutDashboard,
  ListChecks,
  Package,
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
  /** Hidden unless the caller is super_admin or an org admin (M4). */
  requiresOrgScope?: boolean;
}

// Admin sections + lucide mappings per docs/spec/15-brand-design-system.md.
// Sentence case everywhere (spec 15, voice). Landmark for organizations —
// Building2 is taken by clients.
export const adminNavItems: AdminNavItem[] = [
  { label: 'Dashboard', href: '/admin', icon: LayoutDashboard },
  { label: 'Orders', href: '/admin/orders', icon: ClipboardList },
  { label: 'Organizations', href: '/admin/organizations', icon: Landmark, requiresOrgScope: true },
  { label: 'Clients', href: '/admin/clients', icon: Building2 },
  { label: 'Products', href: '/admin/products', icon: Package },
  { label: 'Respondents', href: '/admin/respondents', icon: Users },
  { label: 'Questionnaires', href: '/admin/questionnaires', icon: ListChecks },
  { label: 'Reports', href: '/admin/reports', icon: FileChartColumn },
  { label: 'Billing', href: '/admin/billing', icon: Receipt },
  { label: 'Domains', href: '/admin/domains', icon: Globe },
  { label: 'Error queue', href: '/admin/errors', icon: TriangleAlert },
  { label: 'Settings', href: '/admin/settings', icon: Settings2 },
];

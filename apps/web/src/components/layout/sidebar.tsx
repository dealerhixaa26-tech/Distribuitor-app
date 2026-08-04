'use client';

import {
  BarChart3,
  Boxes,
  Building2,
  FileText,
  LayoutDashboard,
  Map as MapIcon,
  Package,
  Receipt,
  ScrollText,
  Settings,
  ShieldCheck,
  ShoppingCart,
  Tags,
  Users,
  Warehouse,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { PERMISSIONS, type Permission } from '@hixaa/contracts';
import { cn } from '@/lib/utils';
import { usePermission } from '@/lib/use-permission';

interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
  permission: Permission;
  /** Modules that land in later phases are visible but not yet routable. */
  phase?: number;
}

const NAV_SECTIONS: Array<{ heading: string; items: NavItem[] }> = [
  {
    heading: 'Overview',
    items: [
      {
        label: 'Dashboard',
        href: '/dashboard',
        icon: LayoutDashboard,
        permission: PERMISSIONS.ANALYTICS_READ,
      },
    ],
  },
  {
    heading: 'Channel',
    items: [
      {
        label: 'Distributors',
        href: '/distributors',
        icon: Building2,
        permission: PERMISSIONS.DISTRIBUTOR_READ,
      },
      {
        label: 'Customers',
        href: '/customers',
        icon: Users,
        permission: PERMISSIONS.CUSTOMER_READ,
      },
      {
        label: 'Territories',
        href: '/territories',
        icon: MapIcon,
        permission: PERMISSIONS.TERRITORY_READ,
      },
    ],
  },
  {
    heading: 'Catalog',
    items: [
      {
        label: 'Products',
        href: '/products',
        icon: Package,
        permission: PERMISSIONS.PRODUCT_READ,
      },
      {
        label: 'Price lists',
        href: '/price-lists',
        icon: Tags,
        permission: PERMISSIONS.PRICELIST_READ,
      },
      {
        label: 'Inventory',
        href: '/inventory',
        icon: Boxes,
        permission: PERMISSIONS.INVENTORY_READ,
      },
      {
        label: 'Warehouses',
        href: '/warehouses',
        icon: Warehouse,
        permission: PERMISSIONS.WAREHOUSE_READ,
      },
    ],
  },
  {
    heading: 'Sales',
    items: [
      {
        label: 'Quotations',
        href: '/quotations',
        icon: FileText,
        permission: PERMISSIONS.QUOTATION_READ,
      },
      {
        label: 'Orders',
        href: '/orders',
        icon: ShoppingCart,
        permission: PERMISSIONS.ORDER_READ,
      },
    ],
  },
  {
    heading: 'Finance',
    items: [
      {
        label: 'Invoices',
        href: '/invoices',
        icon: Receipt,
        permission: PERMISSIONS.INVOICE_READ,
        phase: 8,
      },
      {
        label: 'Reports',
        href: '/reports',
        icon: BarChart3,
        permission: PERMISSIONS.REPORT_READ,
        phase: 9,
      },
    ],
  },
  {
    heading: 'System',
    items: [
      {
        label: 'Users',
        href: '/users',
        icon: Users,
        permission: PERMISSIONS.USER_READ,
      },
      {
        label: 'Roles',
        href: '/roles',
        icon: ShieldCheck,
        permission: PERMISSIONS.ROLE_READ,
      },
      {
        label: 'Audit log',
        href: '/audit',
        icon: ScrollText,
        permission: PERMISSIONS.AUDITLOG_READ,
      },
      {
        label: 'Settings',
        href: '/settings',
        icon: Settings,
        permission: PERMISSIONS.SETTING_READ,
      },
    ],
  },
];

export function Sidebar({ collapsed = false }: { collapsed?: boolean }) {
  const pathname = usePathname();
  const { can } = usePermission();

  return (
    <nav
      aria-label="Main navigation"
      className={cn(
        'flex h-full flex-col gap-5 overflow-y-auto border-r border-border bg-card px-3 py-4',
        collapsed ? 'w-[60px]' : 'w-60',
      )}
    >
      {NAV_SECTIONS.map((section) => {
        // A section whose every item is denied disappears entirely, rather than
        // leaving an empty heading behind.
        const visible = section.items.filter((item) => can(item.permission));
        if (visible.length === 0) return null;

        return (
          <div key={section.heading}>
            {!collapsed ? (
              <h2 className="mb-1.5 px-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                {section.heading}
              </h2>
            ) : null}

            <ul className="space-y-0.5">
              {visible.map((item) => {
                const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
                const pending = Boolean(item.phase);

                return (
                  <li key={item.href}>
                    <Link
                      href={pending ? '#' : item.href}
                      aria-current={active ? 'page' : undefined}
                      aria-disabled={pending || undefined}
                      title={
                        collapsed
                          ? item.label
                          : pending
                            ? `${item.label} — arrives in Phase ${item.phase}`
                            : undefined
                      }
                      onClick={pending ? (event) => event.preventDefault() : undefined}
                      className={cn(
                        'flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm transition-colors',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        active
                          ? 'bg-primary/10 font-medium text-primary'
                          : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                        pending && 'cursor-not-allowed opacity-45 hover:bg-transparent',
                        collapsed && 'justify-center px-0',
                      )}
                    >
                      <item.icon className="size-4 shrink-0" aria-hidden="true" />
                      {!collapsed ? (
                        <>
                          <span className="truncate">{item.label}</span>
                          {pending ? (
                            <span className="ml-auto shrink-0 rounded bg-muted px-1 py-0.5 text-[9px] font-medium text-muted-foreground">
                              P{item.phase}
                            </span>
                          ) : null}
                        </>
                      ) : null}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}

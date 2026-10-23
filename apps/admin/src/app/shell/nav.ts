/** The dashboard's screens, in navigation order. Each is a lazy route in features/<path>/. */
export interface NavItem {
  path: string;
  label: string;
  /** Shorter label for the bottom bar on phones. */
  short: string;
  /** SVG path data on a 24×24 grid, stroked. */
  icon: string;
  adminOnly?: boolean;
}

export const NAV_ITEMS: NavItem[] = [
  {
    path: 'inbox',
    label: 'Conversas',
    short: 'Conversas',
    icon: 'M4 5h16v11H9l-5 4V5z',
  },
  {
    path: 'leads',
    label: 'Pedidos',
    short: 'Pedidos',
    icon: 'M3 4h18l-7 9v6l-4 2v-8L3 4z',
  },
  {
    path: 'customers',
    label: 'Clientes',
    short: 'Clientes',
    icon: 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6M16 4.3a3.5 3.5 0 0 1 0 6.4M21.5 20c0-2.8-1.6-4.9-4-5.7',
  },
  {
    path: 'knowledge',
    label: 'Conhecimento',
    short: 'Ficheiros',
    icon: 'M5 4.5A1.5 1.5 0 0 1 6.5 3H19v15H6.5A1.5 1.5 0 0 0 5 19.5v-15zM5 19.5A1.5 1.5 0 0 0 6.5 21H19M9 7h6M9 10.5h6',
  },
  {
    path: 'overview',
    label: 'Resumo',
    short: 'Resumo',
    icon: 'M4 20V11M10 20V5M16 20v-6M21 20H3',
  },
  {
    path: 'privacy',
    label: 'Privacidade',
    short: 'Dados',
    icon: 'M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6l7-3zM9 12l2 2 4-4',
    adminOnly: true,
  },
  {
    path: 'settings',
    label: 'Definições',
    short: 'Definições',
    icon: 'M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1M15 4v4M9 10v4M17 16v4',
    adminOnly: true,
  },
];

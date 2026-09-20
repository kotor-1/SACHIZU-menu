"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "./ui";

const LINKS: Array<{ href: string; label: string; exact?: boolean }> = [
  { href: "/", label: "ホーム", exact: true },
  { href: "/exercises", label: "種目" },
  { href: "/menus", label: "メニュー" },
  { href: "/sessions", label: "練習記録" },
  { href: "/competitions", label: "大会" },
  { href: "/ai", label: "動画解析" },
];

export function Nav() {
  const pathname = usePathname();

  return (
    <nav className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
      <ul className="flex items-center gap-1 whitespace-nowrap">
        {LINKS.map((link) => {
          const active = link.exact
            ? pathname === link.href
            : pathname.startsWith(link.href);
          return (
            <li key={link.href}>
              <Link
                href={link.href}
                className={cn(
                  "inline-flex h-9 items-center rounded-lg px-3 text-sm font-medium transition-colors",
                  active
                    ? "bg-slate-900 text-white"
                    : "text-slate-600 hover:bg-slate-100 hover:text-slate-900",
                )}
              >
                {link.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

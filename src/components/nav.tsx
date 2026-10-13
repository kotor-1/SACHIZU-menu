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
      <ul className="flex items-stretch whitespace-nowrap">
        {LINKS.map((link) => {
          const active = link.exact
            ? pathname === link.href
            : pathname.startsWith(link.href);
          return (
            <li key={link.href}>
              <Link
                href={link.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  // 今いる画面は、トラックの赤い線を下に引いて示す
                  "relative inline-flex h-11 items-center px-3 text-sm font-semibold transition-colors sm:h-14",
                  "after:absolute after:inset-x-3 after:bottom-0 after:h-[3px]",
                  active
                    ? "text-white after:bg-indigo-500"
                    : "text-slate-300 after:bg-transparent hover:text-white",
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

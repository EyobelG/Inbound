"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { Github, Linkedin, Menu, X } from "lucide-react";
import { Logo } from "@/components/Logo";
import { NAV_LINKS, SITE } from "@/lib/site";
import { cn } from "@/lib/utils";

const ICON_BUTTON =
  "inline-flex h-9 w-9 items-center justify-center rounded-[10px] border border-border " +
  "text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground";

function SocialLinks({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <a
        href={SITE.repo}
        target="_blank"
        rel="noopener noreferrer"
        aria-label="View the source on GitHub"
        className={ICON_BUTTON}
      >
        <Github className="h-[18px] w-[18px]" />
      </a>
      <a
        href={SITE.author.linkedin}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`${SITE.author.name} on LinkedIn`}
        className={ICON_BUTTON}
      >
        <Linkedin className="h-[18px] w-[18px]" />
      </a>
    </div>
  );
}

export function SiteHeader() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/80 backdrop-blur">
      <div className="mx-auto flex max-w-7xl items-center gap-4 px-4 py-3">
        <Link href="/" className="flex items-center gap-2.5" onClick={() => setOpen(false)}>
          <Logo className="shrink-0" />
          <span className="flex flex-col leading-none">
            <span className="text-base font-bold tracking-tight">{SITE.name}</span>
            <span className="hidden text-[11px] text-muted-foreground sm:block">
              {SITE.tagline}
            </span>
          </span>
        </Link>

        <nav className="ml-4 hidden items-center gap-1 md:flex" aria-label="Main">
          {NAV_LINKS.map((link) => {
            const active = pathname === link.href;
            return (
              <Link
                key={link.href}
                href={link.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "rounded-md px-3 py-1.5 text-sm transition-colors",
                  active
                    ? "bg-muted font-medium text-foreground"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                {link.label}
              </Link>
            );
          })}
        </nav>

        <div className="ml-auto hidden items-center gap-3 md:flex">
          <span className="text-sm text-muted-foreground">
            Built by{" "}
            <a
              href={SITE.author.github}
              target="_blank"
              rel="noopener noreferrer"
              className="font-semibold text-foreground underline-offset-4 hover:underline"
            >
              {SITE.author.name}
            </a>
          </span>
          <SocialLinks />
        </div>

        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls="mobile-nav"
          aria-label={open ? "Close menu" : "Open menu"}
          className="ml-auto rounded-md p-2 text-muted-foreground hover:bg-muted md:hidden"
        >
          {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </button>
      </div>

      {open && (
        <nav
          id="mobile-nav"
          aria-label="Main"
          className="border-t border-border px-4 py-3 md:hidden"
        >
          <ul className="space-y-1">
            {NAV_LINKS.map((link) => (
              <li key={link.href}>
                <Link
                  href={link.href}
                  onClick={() => setOpen(false)}
                  aria-current={pathname === link.href ? "page" : undefined}
                  className={cn(
                    "block rounded-md px-3 py-2 text-sm",
                    pathname === link.href
                      ? "bg-muted font-medium"
                      : "text-muted-foreground hover:bg-muted",
                  )}
                >
                  {link.label}
                </Link>
              </li>
            ))}
          </ul>
          <div className="mt-3 flex items-center justify-between border-t border-border pt-3">
            <span className="text-xs text-muted-foreground">
              Built by{" "}
              <span className="font-semibold text-foreground">{SITE.author.name}</span>
            </span>
            <SocialLinks />
          </div>
        </nav>
      )}
    </header>
  );
}

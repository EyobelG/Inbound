import { Github, Linkedin } from "lucide-react";
import { SITE } from "@/lib/site";

export function SiteFooter() {
  return (
    <footer className="mt-12 border-t border-border">
      <div className="mx-auto flex max-w-7xl flex-col gap-3 px-4 py-6 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
        <p>
          Built by{" "}
          <span className="font-semibold text-foreground">{SITE.author.name}</span>
          {" · "}
          <a
            href={SITE.repo}
            target="_blank"
            rel="noopener noreferrer"
            className="underline-offset-4 hover:underline"
          >
            Source
          </a>
        </p>

        <p className="order-last sm:order-none">
          Transit data from the{" "}
          <a
            href="https://www.mbta.com/developers/v3-api"
            target="_blank"
            rel="noopener noreferrer"
            className="underline-offset-4 hover:underline"
          >
            MBTA V3 API
          </a>
          {" · "}
          Basemap by{" "}
          <a
            href="https://openfreemap.org"
            target="_blank"
            rel="noopener noreferrer"
            className="underline-offset-4 hover:underline"
          >
            OpenFreeMap
          </a>
        </p>

        <div className="flex items-center gap-3">
          <a
            href={SITE.repo}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="View the source on GitHub"
            className="transition-colors hover:text-foreground"
          >
            <Github className="h-4 w-4" />
          </a>
          <a
            href={SITE.author.linkedin}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`${SITE.author.name} on LinkedIn`}
            className="transition-colors hover:text-foreground"
          >
            <Linkedin className="h-4 w-4" />
          </a>
        </div>
      </div>
    </footer>
  );
}

import type { Metadata } from "next";
import { SITE } from "@/lib/site";

export const metadata: Metadata = {
  title: "About",
  description: SITE.description,
};

export default function AboutPage() {
  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <h1 className="text-3xl font-bold tracking-tight">
        Why a midpoint, not a <span className="text-primary">middle</span>
      </h1>

      <div className="mt-6 space-y-5 text-sm leading-relaxed text-muted-foreground">
        <p>
          Splitting the difference geographically is the wrong answer on a radial
          subway network. The geographic midpoint of Davis and Coolidge Corner is
          a point with no station anywhere near it, and getting there means a bus
          transfer neither person wanted.
        </p>
        <p>
          Inbound runs Dijkstra from both starting stations across the real MBTA
          line graph, then ranks every station both people can reach by{" "}
          <span className="font-medium text-foreground">fairness first</span>. A
          hub costing both riders 22 minutes beats one costing 8 and 32, even
          though the totals are identical — because the person with the 32-minute
          ride is the one who cancels.
        </p>

        <h2 className="pt-4 text-lg font-semibold text-foreground">
          Two stops, not one
        </h2>
        <p>
          Step 1 is a low-stakes opener — coffee or a drink, somewhere you can
          leave after 45 minutes without it being a thing. Step 2 is the
          commitment you only make if Step 1 went well, and it has to be within a
          600 metre walk. A 90-minute dinner is never proposed as a first stop.
        </p>

        <h2 className="pt-4 text-lg font-semibold text-foreground">
          Vibe metrics that mean something
        </h2>
        <p>
          Star ratings tell you whether the food was good. They do not tell you
          whether you will be able to hear each other. Inbound scores spots on
          noise, lighting, and how easy it is to wrap up early — the three things
          that actually decide whether a first date works.
        </p>
        <p>
          Spots without reviews score{" "}
          <span className="font-medium text-foreground">neutral, not negative</span>.
          Ranking unreviewed places last would mean nothing new is ever
          discovered, and the map would never grow past its first hundred rows.
        </p>
      </div>

      <div className="mt-10 border-t border-border pt-6 text-sm">
        <p className="text-muted-foreground">
          Built by{" "}
          <a
            href={SITE.author.github}
            target="_blank"
            rel="noopener noreferrer"
            className="font-semibold text-foreground underline-offset-4 hover:underline"
          >
            {SITE.author.name}
          </a>
          . Source on{" "}
          <a
            href={SITE.repo}
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-foreground underline-offset-4 hover:underline"
          >
            GitHub
          </a>
          .
        </p>
      </div>
    </main>
  );
}

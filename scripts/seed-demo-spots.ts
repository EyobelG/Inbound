/**
 * Local-development demo data.
 *
 * These venues are FICTIONAL. They exist so the full pipeline - midpoint ->
 * radius search -> pairing -> rendered itinerary - can be exercised without a
 * Google Places key, and every name carries a "(demo)" suffix so synthetic
 * rows are never mistaken for real recommendations in the UI.
 *
 * Use `npm run seed:spots` for real venues. Never run this against production.
 *
 *   npm run seed:demo
 */
import { getPool } from "../src/lib/db/pool";
import type { PriceTier, SpotCategory } from "../src/types/domain";

interface DemoSpot {
  name: string;
  neighborhood: string;
  lng: number;
  lat: number;
  category: SpotCategory;
  price: PriceTier;
  /** [noise, lighting, easyExit] on the 1-5 scales, applied as seeded reviews. */
  vibe: [number, number, number];
}

/**
 * Clustered around Downtown Crossing / Park Street, which is where the
 * midpoint algorithm lands for most cross-line pairs, so the demo actually
 * has inventory where it looks.
 */
const DEMO_SPOTS: DemoSpot[] = [
  { name: "Quill & Bean (demo)",     neighborhood: "Downtown Crossing", lng: -71.0608, lat: 42.3559, category: "cafe",       price: "$",   vibe: [1.6, 3.2, 4.6] },
  { name: "The Reading Room (demo)", neighborhood: "Downtown Crossing", lng: -71.0615, lat: 42.3551, category: "cafe",       price: "$$",  vibe: [1.9, 2.4, 4.2] },
  { name: "Lamplight Bar (demo)",    neighborhood: "Downtown Crossing", lng: -71.0596, lat: 42.3562, category: "bar",        price: "$$",  vibe: [2.4, 1.5, 3.8] },
  { name: "Brass Rail (demo)",       neighborhood: "Downtown Crossing", lng: -71.0622, lat: 42.3566, category: "bar",        price: "$$$", vibe: [4.3, 2.8, 3.1] },
  { name: "Ember Kitchen (demo)",    neighborhood: "Downtown Crossing", lng: -71.0601, lat: 42.3547, category: "restaurant", price: "$$$", vibe: [2.7, 2.1, 2.4] },
  { name: "Noodle Bar (demo)",       neighborhood: "Chinatown",         lng: -71.0629, lat: 42.3540, category: "restaurant", price: "$$",  vibe: [3.6, 3.9, 3.6] },
  { name: "Sugarhouse (demo)",       neighborhood: "Downtown Crossing", lng: -71.0590, lat: 42.3553, category: "dessert",    price: "$",   vibe: [2.2, 3.6, 4.7] },
  { name: "Pinfall Alley (demo)",    neighborhood: "Downtown Crossing", lng: -71.0634, lat: 42.3558, category: "activity",   price: "$$",  vibe: [4.5, 4.1, 3.3] },
  { name: "Common Green (demo)",     neighborhood: "Boston Common",     lng: -71.0654, lat: 42.3550, category: "walk_park",  price: "$",   vibe: [1.4, 4.4, 4.9] },
  { name: "Gallery 19 (demo)",       neighborhood: "Downtown Crossing", lng: -71.0585, lat: 42.3568, category: "activity",   price: "$$",  vibe: [1.8, 3.3, 4.0] },
];

const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

async function main() {
  const pool = getPool();

  // Reviewers must exist before reviews can reference them.
  const reviewers = ["demo_user_1", "demo_user_2", "demo_user_3"];
  await pool.query(
    `insert into app_users (firebase_uid, display_name)
     select u, 'Demo Reviewer' from unnest($1::text[]) u
     on conflict (firebase_uid) do nothing`,
    [reviewers],
  );

  let count = 0;
  for (const spot of DEMO_SPOTS) {
    // is_verified = true so search returns them; real seeded rows stay false
    // until a human reviews them.
    const { rows } = await pool.query<{ id: string }>(
      `insert into spots
         (name, slug, neighborhood, address, location, price_tier, category,
          opening_hours, is_verified)
       values ($1, $2, $3, $4,
               st_setsrid(st_makepoint($5, $6), 4326)::geography,
               $7::price_tier, $8::spot_category, $9::jsonb, true)
       on conflict (slug) do update set location = excluded.location
       returning id`,
      [
        spot.name, slug(spot.name), spot.neighborhood, "Demo address, Boston MA",
        spot.lng, spot.lat, spot.price, spot.category,
        // Open 08:00-01:00 every day, which exercises the past-midnight branch
        // in isOpenDuring without making the demo time-of-day dependent.
        JSON.stringify(
          Array.from({ length: 7 }, (_, day) => ({ day, open: "08:00", close: "01:00" })),
        ),
      ],
    );

    const spotId = rows[0]!.id;
    const [noise, lighting, exit] = spot.vibe;

    // Write reviews rather than spot_vibes directly: the aggregate is
    // trigger-maintained, and seeding it by hand would bypass the invariant
    // the whole schema is built around.
    const stages = ["first_date", "first_date", "second_or_third"];
    for (const [i, uid] of reviewers.entries()) {
      // Jitter by +/-0 or 1 so confidence() has something to damp and the
      // averages are not suspiciously round.
      const jitter = i === 0 ? 0 : i === 1 ? 0.5 : -0.5;
      const clamp = (v: number) => Math.max(1, Math.min(5, Math.round(v + jitter)));
      await pool.query(
        `insert into user_reviews
           (spot_id, user_id, noise_rating, lighting_rating, easy_exit_rating, date_stage, body_text)
         values ($1, $2, $3, $4, $5, $6::date_stage, $7)
         on conflict (spot_id, user_id) do update set
           noise_rating = excluded.noise_rating`,
        [
          spotId, uid, clamp(noise), clamp(lighting), clamp(exit), stages[i],
          i === 0 ? `Demo review for ${spot.name}. Synthetic data for local development.` : null,
        ],
      );
    }
    count++;
  }

  const { rows: check } = await pool.query<{ n: string }>(
    `select count(*) as n from spot_vibes`,
  );
  console.log(`Seeded ${count} demo spots; spot_vibes now holds ${check[0]!.n} aggregate rows.`);
  console.log("These venues are fictional - for local development only.");
  await pool.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

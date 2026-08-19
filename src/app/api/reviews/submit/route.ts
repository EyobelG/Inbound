import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withUser } from "@/lib/db/pool";
import { ensureAppUser, getAuthedUser } from "@/lib/auth";
import { toErrorResponse } from "@/lib/api/respond";
import { DATE_STAGES } from "@/types/domain";

export const dynamic = "force-dynamic";

const rating = z.coerce.number().int().min(1).max(5);

const ReviewInput = z.object({
  spot_id: z.string().uuid(),
  noise_rating: rating,
  lighting_rating: rating,
  easy_exit_rating: rating,
  date_stage: z.enum(DATE_STAGES),
  body_text: z.string().trim().max(2000).optional().nullable(),
});

/** Postgres: foreign key violation. */
const FK_VIOLATION = "23503";

/**
 * POST /api/reviews/submit
 *
 * Upserts on (spot_id, user_id): resubmitting replaces your previous rating
 * rather than stacking a second vote. The `spot_vibes` aggregate is recomputed
 * by the `user_reviews_recalc_vibes` trigger inside the same transaction, so
 * there is no window where the average disagrees with its reviews and no
 * read-modify-write race between concurrent submitters.
 *
 * The user row, the review, and the aggregate all commit together or not at
 * all - `withUser` wraps the whole handler body in one transaction.
 */
export async function POST(request: NextRequest) {
  try {
    const user = await getAuthedUser(request);
    if (!user) {
      return NextResponse.json(
        { error: { code: "UNAUTHENTICATED", message: "Sign in to leave a review." } },
        { status: 401 },
      );
    }

    const input = ReviewInput.parse(await request.json());

    const result = await withUser(user.uid, async (client) => {
      await ensureAppUser(client, user);

      const { rows } = await client.query<{
        id: string;
        created_at: Date;
        updated_at: Date;
      }>(
        `insert into user_reviews
           (spot_id, user_id, noise_rating, lighting_rating, easy_exit_rating,
            date_stage, body_text)
         values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (spot_id, user_id) do update set
           noise_rating     = excluded.noise_rating,
           lighting_rating  = excluded.lighting_rating,
           easy_exit_rating = excluded.easy_exit_rating,
           date_stage       = excluded.date_stage,
           body_text        = excluded.body_text
         returning id, created_at, updated_at`,
        [
          input.spot_id,
          user.uid,
          input.noise_rating,
          input.lighting_rating,
          input.easy_exit_rating,
          input.date_stage,
          input.body_text?.length ? input.body_text : null,
        ],
      );

      const review = rows[0]!;

      // Read the freshly recomputed aggregate inside the same transaction so
      // the client can update the card without a second round trip.
      //
      // The numerics are cast to float8 in SQL rather than converted in JS:
      // node-postgres hands back `numeric` as a string, and shipping those
      // straight to the client gives it "4.20" where it expects 4.2.
      const { rows: vibeRows } = await client.query(
        `select avg_noise_level::float8  as "avgNoiseLevel",
                lighting_score::float8   as "lightingScore",
                easy_exit_score::float8  as "easyExitScore",
                best_for_stage           as "bestForStage",
                total_reviews_count      as "totalReviewsCount"
           from spot_vibes where spot_id = $1`,
        [input.spot_id],
      );

      return { review, vibes: vibeRows[0] ?? null };
    });

    const isUpdate =
      result.review.created_at.getTime() !== result.review.updated_at.getTime();

    return NextResponse.json(result, { status: isUpdate ? 200 : 201 });
  } catch (error) {
    if ((error as { code?: string }).code === FK_VIOLATION) {
      return NextResponse.json(
        { error: { code: "SPOT_NOT_FOUND", message: "That spot no longer exists." } },
        { status: 404 },
      );
    }
    return toErrorResponse(error);
  }
}

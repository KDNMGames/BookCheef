import "jsr:@supabase/functions-js/edge-runtime.d.ts";

Deno.serve((_req: Request) => {
  return Response.json(
    {
      ok: false,
      disabled: true,
      error: "The legacy BookCheef generation and publication endpoint has been retired.",
    },
    { status: 410 },
  );
});

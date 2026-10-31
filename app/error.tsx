"use client";

export default function CatalogError({ reset }: { reset: () => void }) {
  return <main className="loading error" role="alert">
    <h1>Catalog unavailable</h1>
    <p>We couldn&apos;t load the product catalog. Please check that Supabase is running and try again.</p>
    <button type="button" onClick={reset}>Try again</button>
  </main>;
}

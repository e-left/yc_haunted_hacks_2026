export interface Product {
  asin: string;
  brand: string;
  name: string;
  shortName: string;
  color: string;
  packSize: number | null;
  fabric: string;
  fit: string;
  weight: string | null;
  sizes: string[];
  defaultSize: string;
  priceUsd: number | null;
  priceBasis: string;
  rating: number | null;
  reviewCount: string | null;
  badge: string | null;
  image: string;
  sourceUrl: string;
  highlights: string[];
}

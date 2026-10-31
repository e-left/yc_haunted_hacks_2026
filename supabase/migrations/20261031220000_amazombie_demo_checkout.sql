-- Extend the existing Amazombie merchant catalog with sample prices and a demo checkout.
-- public.products and public.product_variants already contain the 24 storefront products.
BEGIN;

UPDATE public.products AS product
SET sample_price_usd = prices.price_usd,
    price_basis = 'Sample US dollar price; not a live offer'
FROM (VALUES
    ('B0DK3XH9HH', 16.99), ('B09TPJXFH8', 13.99),
    ('B07RYSG814', 14.99), ('B0D37QFR64', 24.99),
    ('B0BJZSSMVZ', 19.99), ('B0F6D6PLX4', 17.99),
    ('B0DK978M4D', 22.99), ('B0GYGD22JP', 19.99),
    ('B00KBZOTKG', 21.99), ('B071DVQLT2', 16.99),
    ('B0CCBWC2K3', 18.99), ('B0D2PKQGQV', 23.99),
    ('B0G3NKZ6KZ', 22.99), ('B0D4M3WMSK', 18.99),
    ('B07612XWPL', 12.99), ('B07M8NX6YB', 15.99),
    ('B077ZJC1N9', 18.99), ('B01MTXCBVF', 16.99),
    ('B07MKKM952', 14.99), ('B09TPLS41B', 12.99),
    ('B0DN5TR7VL', 14.99), ('B0C1Z4KFGZ', 18.99),
    ('B08F2P8CS9', 19.99), ('B07D126W6P', 24.99)
) AS prices(asin, price_usd)
JOIN public.merchants AS merchant ON merchant.slug = 'amazombie'
WHERE product.merchant_id = merchant.id
  AND product.asin = prices.asin
  AND product.sample_price_usd IS NULL;

CREATE OR REPLACE FUNCTION public.amazombie_catalog()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'asin', product.asin,
        'brand', product.brand,
        'name', product.name,
        'shortName', product.short_name,
        'color', product.color,
        'packSize', product.pack_size,
        'fabric', product.fabric,
        'fit', product.fit,
        'weight', product.weight,
        'sizes', (
            SELECT COALESCE(jsonb_agg(variant.size ORDER BY
                array_position(ARRAY['XS','S','M','L','XL','XXL','3XL','4XL'], variant.size)
            ), '[]'::jsonb)
            FROM public.product_variants AS variant
            WHERE variant.product_id = product.id
              AND variant.merchant_id = product.merchant_id
        ),
        'defaultSize', product.default_size,
        'priceUsd', product.sample_price_usd,
        'priceBasis', product.price_basis,
        'rating', product.rating,
        'reviewCount', product.review_count,
        'badge', product.badge,
        'image', product.image_path,
        'sourceUrl', product.source_url,
        'highlights', product.highlights
    ) ORDER BY product.created_at, product.asin), '[]'::jsonb)
    FROM public.products AS product
    JOIN public.merchants AS merchant ON merchant.id = product.merchant_id
    WHERE merchant.slug = 'amazombie';
$$;
REVOKE ALL ON FUNCTION public.amazombie_catalog() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.amazombie_catalog() TO anon, authenticated;

CREATE SCHEMA IF NOT EXISTS amazombie_private;
REVOKE ALL ON SCHEMA amazombie_private FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS amazombie_private.orders (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id uuid NOT NULL REFERENCES public.merchants(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    total_cents integer NOT NULL CHECK (total_cents >= 0),
    currency text NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
    status text NOT NULL DEFAULT 'demo' CHECK (status = 'demo')
);
CREATE TABLE IF NOT EXISTS amazombie_private.order_items (
    order_id uuid NOT NULL REFERENCES amazombie_private.orders(id) ON DELETE CASCADE,
    variant_id uuid NOT NULL REFERENCES public.product_variants(id),
    asin text NOT NULL,
    size text NOT NULL,
    quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 10),
    unit_price_cents integer NOT NULL CHECK (unit_price_cents > 0),
    line_total_cents integer NOT NULL CHECK (line_total_cents = unit_price_cents * quantity),
    PRIMARY KEY (order_id, variant_id)
);
ALTER TABLE amazombie_private.orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE amazombie_private.order_items ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA amazombie_private FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.amazombie_place_demo_order(p_items jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    item jsonb;
    amazombie_merchant_id uuid;
    requested_asin text;
    requested_size text;
    requested_quantity integer;
    quantity_text text;
    selected_variant_id uuid;
    selected_price numeric;
    price_cents integer;
    new_order_id uuid;
    calculated_total_cents integer := 0;
    total_quantity integer := 0;
BEGIN
    IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' THEN
        RAISE EXCEPTION 'Order items must be an array' USING ERRCODE = '22023';
    END IF;
    IF jsonb_array_length(p_items) NOT BETWEEN 1 AND 20 OR octet_length(p_items::text) > 4096 THEN
        RAISE EXCEPTION 'Order must have 1 to 20 valid lines' USING ERRCODE = '22023';
    END IF;
    SELECT id INTO amazombie_merchant_id FROM public.merchants WHERE slug = 'amazombie';
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Amazombie merchant is unavailable' USING ERRCODE = '22023';
    END IF;

    INSERT INTO amazombie_private.orders (merchant_id, total_cents)
        VALUES (amazombie_merchant_id, 0) RETURNING id INTO new_order_id;
    FOR item IN SELECT value FROM jsonb_array_elements(p_items) AS lines(value) LOOP
        requested_asin := item->>'asin';
        requested_size := item->>'size';
        quantity_text := item->>'quantity';
        IF jsonb_typeof(item) <> 'object'
           OR requested_asin IS NULL OR requested_size IS NULL
           OR quantity_text IS NULL OR quantity_text !~ '^[1-9][0-9]?$' THEN
            RAISE EXCEPTION 'Invalid order line' USING ERRCODE = '22023';
        END IF;
        requested_quantity := quantity_text::integer;
        IF requested_quantity > 10 THEN
            RAISE EXCEPTION 'Quantity must be between 1 and 10' USING ERRCODE = '22023';
        END IF;
        SELECT variant.id, product.sample_price_usd
            INTO selected_variant_id, selected_price
            FROM public.products AS product
            JOIN public.product_variants AS variant
              ON variant.product_id = product.id
             AND variant.merchant_id = product.merchant_id
            WHERE product.merchant_id = amazombie_merchant_id
              AND product.asin = requested_asin
              AND variant.size = requested_size;
        IF NOT FOUND OR selected_price IS NULL OR selected_price <= 0 THEN
            RAISE EXCEPTION 'Product or size is unavailable' USING ERRCODE = '22023';
        END IF;
        price_cents := round(selected_price * 100)::integer;
        total_quantity := total_quantity + requested_quantity;
        IF total_quantity > 50 THEN
            RAISE EXCEPTION 'Order has too many items' USING ERRCODE = '22023';
        END IF;
        INSERT INTO amazombie_private.order_items
            (order_id, variant_id, asin, size, quantity, unit_price_cents, line_total_cents)
        VALUES
            (new_order_id, selected_variant_id, requested_asin, requested_size,
             requested_quantity, price_cents, price_cents * requested_quantity);
        calculated_total_cents := calculated_total_cents + price_cents * requested_quantity;
    END LOOP;

    UPDATE amazombie_private.orders SET total_cents = calculated_total_cents
        WHERE id = new_order_id;
    RETURN jsonb_build_object(
        'id', new_order_id,
        'placedAt', now(),
        'totalCents', calculated_total_cents,
        'currency', 'USD',
        'status', 'demo'
    );
END;
$$;
REVOKE ALL ON FUNCTION public.amazombie_place_demo_order(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.amazombie_place_demo_order(jsonb) TO anon, authenticated;
COMMIT;

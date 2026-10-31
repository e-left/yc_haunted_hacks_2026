-- Amazombie's sample catalog and anonymous demo checkout.
-- The public catalog is readable; orders are written only through the RPC below.

CREATE TABLE public.amazombie_products (
    asin text PRIMARY KEY CHECK (asin ~ '^[A-Z0-9]{10}$'),
    price_cents integer NOT NULL CHECK (price_cents > 0),
    sizes text[] NOT NULL CHECK (cardinality(sizes) BETWEEN 1 AND 12),
    sort_order integer NOT NULL UNIQUE,
    active boolean NOT NULL DEFAULT true
);
ALTER TABLE public.amazombie_products ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.amazombie_products FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA public TO anon, authenticated;
GRANT SELECT ON public.amazombie_products TO anon, authenticated;
CREATE POLICY amazombie_products_visible ON public.amazombie_products
    FOR SELECT TO anon, authenticated USING (active);

-- Prices and sizes are sample data, matching amazombie-demo/data/products.json.
INSERT INTO public.amazombie_products (sort_order, asin, price_cents, sizes) VALUES
    (1, 'B0DK3XH9HH', 1699, ARRAY['S','M','L','XL','XXL','3XL']),
    (2, 'B09TPJXFH8', 1399, ARRAY['S','M','L','XL','XXL']),
    (3, 'B07RYSG814', 1499, ARRAY['S','M','L','XL','XXL']),
    (4, 'B0D37QFR64', 2499, ARRAY['S','M','L','XL','XXL','3XL']),
    (5, 'B0BJZSSMVZ', 1999, ARRAY['S','M','L','XL','XXL']),
    (6, 'B0F6D6PLX4', 1799, ARRAY['S','M','L','XL','XXL']),
    (7, 'B0DK978M4D', 2299, ARRAY['S','M','L','XL','XXL']),
    (8, 'B0GYGD22JP', 1999, ARRAY['S','M','L','XL','XXL']),
    (9, 'B00KBZOTKG', 2199, ARRAY['S','M','L','XL','XXL']),
    (10, 'B071DVQLT2', 1699, ARRAY['S','M','L','XL','XXL']),
    (11, 'B0CCBWC2K3', 1899, ARRAY['S','M','L','XL','XXL']),
    (12, 'B0D2PKQGQV', 2399, ARRAY['S','M','L','XL','XXL']),
    (13, 'B0G3NKZ6KZ', 2299, ARRAY['S','M','L','XL','XXL']),
    (14, 'B0D4M3WMSK', 1899, ARRAY['S','M','L','XL','XXL']),
    (15, 'B07612XWPL', 1299, ARRAY['S','M','L','XL','XXL']),
    (16, 'B07M8NX6YB', 1599, ARRAY['S','M','L','XL','XXL']),
    (17, 'B077ZJC1N9', 1899, ARRAY['S','M','L','XL','XXL']),
    (18, 'B01MTXCBVF', 1699, ARRAY['S','M','L','XL','XXL']),
    (19, 'B07MKKM952', 1499, ARRAY['S','M','L','XL','XXL']),
    (20, 'B09TPLS41B', 1299, ARRAY['S','M','L','XL','XXL']),
    (21, 'B0DN5TR7VL', 1499, ARRAY['S','M','L','XL','XXL']),
    (22, 'B0C1Z4KFGZ', 1899, ARRAY['S','M','L','XL','XXL']),
    (23, 'B08F2P8CS9', 1999, ARRAY['S','M','L','XL','XXL']),
    (24, 'B07D126W6P', 2499, ARRAY['S','M','L','XL','XXL']);

CREATE SCHEMA amazombie_private;
REVOKE ALL ON SCHEMA amazombie_private FROM PUBLIC, anon, authenticated;

CREATE TABLE amazombie_private.orders (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at timestamptz NOT NULL DEFAULT now(),
    total_cents integer NOT NULL CHECK (total_cents >= 0),
    currency text NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
    status text NOT NULL DEFAULT 'demo' CHECK (status = 'demo')
);
CREATE TABLE amazombie_private.order_items (
    order_id uuid NOT NULL REFERENCES amazombie_private.orders(id) ON DELETE CASCADE,
    asin text NOT NULL REFERENCES public.amazombie_products(asin),
    size text NOT NULL,
    quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 10),
    unit_price_cents integer NOT NULL CHECK (unit_price_cents > 0),
    line_total_cents integer NOT NULL CHECK (line_total_cents = unit_price_cents * quantity),
    PRIMARY KEY (order_id, asin, size)
);
ALTER TABLE amazombie_private.orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE amazombie_private.order_items ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA amazombie_private FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.amazombie_place_demo_order(p_items jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    item jsonb;
    requested_asin text;
    requested_size text;
    requested_quantity integer;
    quantity_text text;
    product public.amazombie_products%ROWTYPE;
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

    INSERT INTO amazombie_private.orders (total_cents) VALUES (0) RETURNING id INTO new_order_id;
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
        SELECT * INTO product FROM public.amazombie_products
            WHERE asin = requested_asin AND active;
        IF NOT FOUND OR NOT requested_size = ANY(product.sizes) THEN
            RAISE EXCEPTION 'Product or size is unavailable' USING ERRCODE = '22023';
        END IF;
        total_quantity := total_quantity + requested_quantity;
        IF total_quantity > 50 THEN
            RAISE EXCEPTION 'Order has too many items' USING ERRCODE = '22023';
        END IF;
        INSERT INTO amazombie_private.order_items
            (order_id, asin, size, quantity, unit_price_cents, line_total_cents)
        VALUES
            (new_order_id, requested_asin, requested_size, requested_quantity,
             product.price_cents, product.price_cents * requested_quantity);
        calculated_total_cents := calculated_total_cents + product.price_cents * requested_quantity;
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

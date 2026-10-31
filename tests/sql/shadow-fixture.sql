\set ON_ERROR_STOP on
insert into public.merchants (slug, name) values ('amazombie', 'Test Merchant');
insert into public.products (merchant_id, asin, brand, name, short_name, color, fabric, fit, default_size, price_basis, image_path, source_url)
select m.id, p.asin, 'Test Brand', p.name, p.name, 'Test', 'Test', 'Test', 'M', 'Test price', 'test.jpg', 'https://example.invalid'
from public.merchants m cross join (values ('B0DK3XH9HH', 'Approved product'), ('OTHER', 'Other product')) as p(asin, name)
where m.slug = 'amazombie';
insert into public.data_classifications (merchant_id, resource, field_name, category)
select m.id, x.resource, x.field_name, x.category
from public.merchants m cross join (values
  ('products', 'merchant_id', 'reviewable'), ('products', 'asin', 'reviewable'),
  ('products', 'brand', 'reviewable'), ('products', 'name', 'reviewable'),
  ('supplier_costs', 'unit_cost_usd', 'private'), ('carts', 'id', 'custodial')
) as x(resource, field_name, category) where m.slug = 'amazombie';

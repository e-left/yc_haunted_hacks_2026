-- Data starts inaccessible to application roles; access is added only after
-- the corresponding identity and review controls exist.
create table public.merchants (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  created_at timestamptz not null default now()
);

create table public.products (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants(id),
  asin text not null,
  brand text not null,
  name text not null,
  short_name text not null,
  color text not null,
  pack_size integer check (pack_size > 0),
  fabric text not null,
  fit text not null,
  weight text,
  default_size text not null,
  sample_price_usd numeric(10,2) check (sample_price_usd >= 0),
  price_basis text not null,
  rating numeric(3,2) check (rating between 0 and 5),
  review_count text,
  badge text,
  image_path text not null,
  source_url text not null,
  highlights text[] not null default '{}',
  created_at timestamptz not null default now(),
  unique (merchant_id, asin),
  unique (merchant_id, id)
);

-- Sizes are samples from the storefront, not evidence of stock.
create table public.product_variants (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null,
  product_id uuid not null,
  size text not null,
  foreign key (merchant_id, product_id) references public.products(merchant_id, id),
  unique (merchant_id, product_id, size),
  unique (merchant_id, id)
);

create table public.inventory (
  merchant_id uuid not null,
  variant_id uuid not null,
  quantity integer not null check (quantity >= 0),
  updated_at timestamptz not null default now(),
  primary key (merchant_id, variant_id),
  foreign key (merchant_id, variant_id) references public.product_variants(merchant_id, id)
);

create table public.product_measurements (
  merchant_id uuid not null,
  variant_id uuid not null,
  body_length_inches numeric(6,2) check (body_length_inches > 0),
  source text,
  primary key (merchant_id, variant_id),
  foreign key (merchant_id, variant_id) references public.product_variants(merchant_id, id)
);

create table public.supplier_costs (
  merchant_id uuid not null,
  variant_id uuid not null,
  unit_cost_usd numeric(10,2) not null check (unit_cost_usd >= 0),
  primary key (merchant_id, variant_id),
  foreign key (merchant_id, variant_id) references public.product_variants(merchant_id, id)
);

create table public.customer_profiles (
  merchant_id uuid not null references public.merchants(id),
  user_id uuid not null references auth.users(id),
  display_name text,
  primary key (merchant_id, user_id)
);

create table public.carts (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null,
  user_id uuid not null,
  status text not null default 'open' check (status in ('open', 'closed')),
  created_at timestamptz not null default now(),
  foreign key (merchant_id, user_id) references public.customer_profiles(merchant_id, user_id),
  unique (merchant_id, id)
);
create unique index carts_one_open_per_customer
  on public.carts (merchant_id, user_id) where status = 'open';

create table public.cart_items (
  merchant_id uuid not null,
  cart_id uuid not null,
  variant_id uuid not null,
  quantity integer not null check (quantity > 0),
  primary key (merchant_id, cart_id, variant_id),
  foreign key (merchant_id, cart_id) references public.carts(merchant_id, id),
  foreign key (merchant_id, variant_id) references public.product_variants(merchant_id, id)
);
create index cart_items_variant_idx on public.cart_items (merchant_id, variant_id);

-- Missing classifications deny access. Only trusted merchant administration
-- will be allowed to change these records.
create table public.data_classifications (
  merchant_id uuid not null references public.merchants(id),
  resource text not null,
  field_name text not null,
  category text not null check (category in ('private', 'custodial', 'reviewable')),
  primary key (merchant_id, resource, field_name)
);

alter table public.merchants enable row level security;
alter table public.products enable row level security;
alter table public.product_variants enable row level security;
alter table public.inventory enable row level security;
alter table public.product_measurements enable row level security;
alter table public.supplier_costs enable row level security;
alter table public.customer_profiles enable row level security;
alter table public.carts enable row level security;
alter table public.cart_items enable row level security;
alter table public.data_classifications enable row level security;

revoke all on table public.merchants, public.products, public.product_variants,
  public.inventory, public.product_measurements, public.supplier_costs,
  public.customer_profiles, public.carts, public.cart_items,
  public.data_classifications from public, anon, authenticated;

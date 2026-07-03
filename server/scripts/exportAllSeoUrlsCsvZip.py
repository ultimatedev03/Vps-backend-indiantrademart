#!/usr/bin/env python3
import csv
import io
import os
import re
import shutil
import subprocess
import sys
import zipfile
from datetime import datetime
from pathlib import Path


DB = os.environ.get("MYSQL_DATABASE") or os.environ.get("DB_NAME") or "indiantrademart"
USER = os.environ.get("MYSQL_USER") or os.environ.get("DB_USER") or "root"
PASS = os.environ.get("MYSQL_PASSWORD") if os.environ.get("MYSQL_PASSWORD") is not None else os.environ.get("DB_PASS", "")
HOST = os.environ.get("MYSQL_HOST") or "127.0.0.1"
PORT = os.environ.get("MYSQL_PORT") or "3306"
SITE = (os.environ.get("SITE_URL") or "https://indiantrademart.com").rstrip("/")
ROWS_PER_FILE = int(os.environ.get("ROWS_PER_FILE") or "900000")
CATEGORY_SCOPE = (os.environ.get("CATEGORY_SCOPE") or "all").strip().lower()

DEFAULT_EXPORT_DIR = Path(os.environ.get("EXPORT_DIR") or "/var/www/indiantrademart/seo-url-exports")
STAMP = datetime.utcnow().strftime("%Y%m%d-%H%M%S")
OUT = Path(os.environ.get("OUT_FILE") or DEFAULT_EXPORT_DIR / f"indiantrademart-all-seo-live-urls-{STAMP}.zip")
MIRROR_DIR = Path(os.environ.get("MIRROR_DIR") or OUT.with_suffix(""))


def slugify(value):
    text = str(value or "").strip().lower()
    text = text.replace("&", " and ")
    text = re.sub(r"[^a-z0-9]+", "-", text)
    text = re.sub(r"-+", "-", text).strip("-")
    return text or "india"


def mysql_query(sql):
    env = os.environ.copy()
    env["MYSQL_PWD"] = PASS
    cmd = [
        "mysql",
        "-h",
        HOST,
        "-P",
        str(PORT),
        "-u",
        USER,
        "--batch",
        "--raw",
        "--skip-column-names",
        "--default-character-set=utf8mb4",
        DB,
        "-e",
        sql,
    ]
    proc = subprocess.run(
        cmd,
        env=env,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if proc.returncode != 0:
        print("MYSQL ERROR:", proc.stderr.strip(), file=sys.stderr)
        print("FAILED SQL:", sql[:2000], file=sys.stderr)
        raise SystemExit(proc.returncode)

    rows = []
    for line in proc.stdout.splitlines():
        rows.append(line.split("\t"))
    return rows


def has_table(table_name):
    rows = mysql_query(
        f"SELECT COUNT(*) FROM information_schema.TABLES "
        f"WHERE TABLE_SCHEMA='{DB}' AND TABLE_NAME='{table_name}'"
    )
    return bool(rows and rows[0][0] != "0")


def has_col(table_name, column_name):
    rows = mysql_query(
        f"SELECT COUNT(*) FROM information_schema.COLUMNS "
        f"WHERE TABLE_SCHEMA='{DB}' AND TABLE_NAME='{table_name}' AND COLUMN_NAME='{column_name}'"
    )
    return bool(rows and rows[0][0] != "0")


def loc_url(base_slug, loc):
    state_slug = slugify(loc["state_slug"] or loc["state"])
    district_slug = slugify(loc["district_slug"] or loc["district"])
    city_slug = slugify(loc["city_slug"] or loc["city"])
    if district_slug and district_slug != city_slug:
        return f"{SITE}/directory/search/{base_slug}/{state_slug}/{district_slug}/{city_slug}"
    return f"{SITE}/directory/search/{base_slug}/{state_slug}/{city_slug}"


def seo_text(value, fallback=""):
    text = str(value or fallback or "").strip()
    return re.sub(r"\s+", " ", text)


def location_label(loc):
    parts = [loc.get("city"), loc.get("district"), loc.get("state")]
    clean = []
    for item in parts:
        item = seo_text(item)
        if item and item.lower() not in {x.lower() for x in clean}:
            clean.append(item)
    return ", ".join(clean) or "India"


def category_keywords(micro):
    items = [
        micro.get("keywords"),
        micro.get("meta_tags"),
        micro.get("name"),
        micro.get("sub_name"),
        micro.get("head_name"),
        "suppliers",
        "manufacturers",
        "IndianTradeMart",
    ]
    seen = set()
    out = []
    for item in items:
        for part in str(item or "").replace("|", ",").split(","):
            val = seo_text(part)
            key = val.lower()
            if val and key not in seen:
                seen.add(key)
                out.append(val)
    return ", ".join(out[:30])


def search_meta(service_name, loc, micro=None):
    place = location_label(loc)
    title = f"{seo_text(service_name)} Suppliers & Manufacturers in {place} | IndianTradeMart"
    description = (
        f"Find verified {seo_text(service_name).lower()} suppliers, manufacturers, dealers and service providers "
        f"in {place}. Compare prices, send enquiry and connect with trusted vendors on IndianTradeMart."
    )
    keywords = category_keywords(micro or {"name": service_name})
    if place and place != "India":
        keywords = f"{keywords}, {seo_text(service_name)} in {place}, {seo_text(service_name)} suppliers in {place}"
    return title, description, keywords


def product_meta(product, loc=None):
    product_name = seo_text(product.get("name"), "Product")
    if loc:
        return search_meta(product_name, loc)
    return (
        f"{product_name} - Suppliers, Manufacturers & Price | IndianTradeMart",
        f"View {product_name} details, price, suppliers and manufacturers on IndianTradeMart. Send enquiry to verified vendors.",
        f"{product_name}, {product_name} suppliers, {product_name} manufacturers, IndianTradeMart",
    )


def vendor_meta(vendor, loc=None):
    company = seo_text(vendor.get("company"), "Vendor")
    if loc:
        place = location_label(loc)
        return (
            f"{company} Products & Services in {place} | IndianTradeMart",
            f"Explore {company} products and services available in {place}. Contact supplier and send business enquiry on IndianTradeMart.",
            f"{company}, {company} {place}, suppliers in {place}, IndianTradeMart",
        )
    return (
        f"{company} - Company Profile, Products & Contact | IndianTradeMart",
        f"View {company} company profile, products, services, contact details and business information on IndianTradeMart.",
        f"{company}, {company} products, {company} contact, IndianTradeMart",
    )


def write_chunks(zip_file, base_name, header, iterable):
    part = 1
    current = []
    total = 0

    def flush():
        nonlocal part, current
        if not current:
            return
        buffer = io.StringIO()
        writer = csv.writer(buffer)
        writer.writerow(header)
        writer.writerows(current)
        file_name = f"{base_name}-part-{part:03d}.csv"
        csv_text = buffer.getvalue()
        zip_file.writestr(file_name, csv_text)
        MIRROR_DIR.mkdir(parents=True, exist_ok=True)
        (MIRROR_DIR / file_name).write_text(csv_text, encoding="utf-8", newline="")
        part += 1
        current = []

    for row in iterable:
        current.append(row)
        total += 1
        if len(current) >= ROWS_PER_FILE:
            flush()

    flush()
    return total


def normalize_rows(rows, keys):
    out = []
    for row in rows:
        item = {}
        for idx, key in enumerate(keys):
            item[key] = row[idx] if idx < len(row) else ""
        out.append(item)
    return out


def main():
    OUT.parent.mkdir(parents=True, exist_ok=True)
    if MIRROR_DIR.exists():
        shutil.rmtree(MIRROR_DIR)
    MIRROR_DIR.mkdir(parents=True, exist_ok=True)

    locations = normalize_rows(
        mysql_query(
            """
SELECT
  s.id,
  COALESCE(s.name,''),
  COALESCE(NULLIF(s.slug,''), LOWER(REPLACE(s.name,' ','-'))),
  COALESCE(d.id,''),
  COALESCE(d.name,''),
  COALESCE(NULLIF(d.slug,''), LOWER(REPLACE(d.name,' ','-'))),
  c.id,
  COALESCE(c.name,''),
  COALESCE(NULLIF(c.slug,''), LOWER(REPLACE(c.name,' ','-')))
FROM cities c
JOIN states s ON s.id = c.state_id
LEFT JOIN districts d ON d.id = c.district_id
WHERE COALESCE(c.is_active,1)=1 AND COALESCE(s.is_active,1)=1
ORDER BY s.name, d.name, c.name
"""
        ),
        ["state_id", "state", "state_slug", "district_id", "district", "district_slug", "city_id", "city", "city_slug"],
    )

    all_india_expr = "COALESCE(v.all_india_visibility,0)" if has_col("vendors", "all_india_visibility") else "0"
    vendors = normalize_rows(
        mysql_query(
            f"""
SELECT
  v.id,
  COALESCE(v.vendor_id,''),
  COALESCE(NULLIF(v.company_name,''), v.email, 'vendor'),
  COALESCE(v.email,''),
  COALESCE(NULLIF(v.slug,''), LOWER(REPLACE(COALESCE(v.company_name,v.vendor_id,v.id),' ','-'))),
  COALESCE(v.state_id,''),
  COALESCE(v.district_id,''),
  COALESCE(v.city_id,''),
  {all_india_expr}
FROM vendors v
WHERE COALESCE(v.is_active,1)=1
ORDER BY v.created_at DESC
"""
        ),
        ["id", "vendor_code", "company", "email", "slug", "state_id", "district_id", "city_id", "all_india"],
    )

    products = normalize_rows(
        mysql_query(
            """
SELECT
  p.id,
  COALESCE(p.vendor_id,''),
  COALESCE(NULLIF(p.name,''), 'product'),
  COALESCE(NULLIF(p.slug,''), LOWER(REPLACE(COALESCE(p.name,p.id),' ','-'))),
  COALESCE(p.micro_category_id,''),
  COALESCE(p.sub_category_id,''),
  COALESCE(p.head_category_id,'')
FROM products p
WHERE LOWER(COALESCE(p.status,'active')) NOT IN ('deleted','inactive','rejected')
ORDER BY p.created_at DESC
"""
        ),
        ["id", "vendor_id", "name", "slug", "micro_id", "sub_id", "head_id"],
    )

    if has_table("head_categories"):
        micro_sql = """
SELECT
  mc.id,
  COALESCE(mc.name,''),
  COALESCE(NULLIF(mc.slug,''), LOWER(REPLACE(mc.name,' ','-'))),
  COALESCE(sc.id,''),
  COALESCE(sc.name,''),
  COALESCE(NULLIF(sc.slug,''), LOWER(REPLACE(sc.name,' ','-'))),
  COALESCE(hc.id,''),
  COALESCE(hc.name,''),
  COALESCE(NULLIF(hc.slug,''), LOWER(REPLACE(hc.name,' ','-'))),
  COALESCE((SELECT m.meta_tags FROM micro_category_meta m WHERE m.micro_categories=mc.id ORDER BY m.updated_at DESC LIMIT 1),''),
  COALESCE((SELECT m.description FROM micro_category_meta m WHERE m.micro_categories=mc.id ORDER BY m.updated_at DESC LIMIT 1),''),
  COALESCE((SELECT m.keywords FROM micro_category_meta m WHERE m.micro_categories=mc.id ORDER BY m.updated_at DESC LIMIT 1),'')
FROM micro_categories mc
LEFT JOIN sub_categories sc ON sc.id=mc.sub_category_id
LEFT JOIN head_categories hc ON hc.id=sc.head_category_id
WHERE COALESCE(mc.is_active,1)=1
ORDER BY hc.name, sc.name, mc.name
"""
    else:
        micro_sql = """
SELECT
  mc.id,
  COALESCE(mc.name,''),
  COALESCE(NULLIF(mc.slug,''), LOWER(REPLACE(mc.name,' ','-'))),
  COALESCE(sc.id,''),
  COALESCE(sc.name,''),
  COALESCE(NULLIF(sc.slug,''), LOWER(REPLACE(sc.name,' ','-'))),
  '',
  '',
  '',
  COALESCE((SELECT m.meta_tags FROM micro_category_meta m WHERE m.micro_categories=mc.id ORDER BY m.updated_at DESC LIMIT 1),''),
  COALESCE((SELECT m.description FROM micro_category_meta m WHERE m.micro_categories=mc.id ORDER BY m.updated_at DESC LIMIT 1),''),
  COALESCE((SELECT m.keywords FROM micro_category_meta m WHERE m.micro_categories=mc.id ORDER BY m.updated_at DESC LIMIT 1),'')
FROM micro_categories mc
LEFT JOIN sub_categories sc ON sc.id=mc.sub_category_id
WHERE COALESCE(mc.is_active,1)=1
ORDER BY sc.name, mc.name
"""

    micros = normalize_rows(
        mysql_query(micro_sql),
        ["id", "name", "slug", "sub_id", "sub_name", "sub_slug", "head_id", "head_name", "head_slug", "meta_tags", "description", "keywords"],
    )

    vendor_by_id = {row["id"]: row for row in vendors}
    micro_by_id = {row["id"]: row for row in micros}
    used_micro_ids = {row["micro_id"] for row in products if row.get("micro_id")}

    service_pairs = []
    seen_service_pairs = set()
    for product in products:
        micro = micro_by_id.get(product.get("micro_id"))
        if not micro:
            continue
        key = (product["vendor_id"], micro["id"])
        if key in seen_service_pairs:
            continue
        seen_service_pairs.add(key)
        service_pairs.append((product["vendor_id"], micro))

    summary = []

    with zipfile.ZipFile(OUT, "w", compression=zipfile.ZIP_DEFLATED) as zip_file:
        total = write_chunks(
            zip_file,
            "01-location-catalog",
            ["State ID", "State", "State Slug", "District ID", "District", "District Slug", "City ID", "City", "City Slug", "URL", "Title", "Description", "Keywords"],
            (
                [
                    loc["state_id"],
                    loc["state"],
                    loc["state_slug"],
                    loc["district_id"],
                    loc["district"],
                    loc["district_slug"],
                    loc["city_id"],
                    loc["city"],
                    loc["city_slug"],
                    loc_url("all", loc),
                    f"Suppliers & Manufacturers in {location_label(loc)} | IndianTradeMart",
                    f"Find verified suppliers, manufacturers, exporters and service providers in {location_label(loc)} on IndianTradeMart.",
                    f"suppliers in {location_label(loc)}, manufacturers in {location_label(loc)}, IndianTradeMart",
                ]
                for loc in locations
            ),
        )
        summary.append(["Location catalog", total])

        static_pages = [
            ["Home", f"{SITE}/"],
            ["Directory", f"{SITE}/directory"],
            ["Products", f"{SITE}/products"],
            ["Pricing", f"{SITE}/pricing"],
            ["Blog", f"{SITE}/blog"],
            ["Buyer Register", f"{SITE}/buyer/register"],
            ["Vendor Register", f"{SITE}/vendor/register"],
            ["Vendor Login", f"{SITE}/vendor/login"],
            ["Buyer Login", f"{SITE}/buyer/login"],
            ["About", f"{SITE}/about"],
            ["Contact", f"{SITE}/contact"],
        ]
        buffer = io.StringIO()
        writer = csv.writer(buffer)
        writer.writerow(["Page", "URL", "Title", "Description", "Keywords"])
        writer.writerows([
            [
                page,
                url,
                f"{page} | IndianTradeMart",
                f"{page} page on IndianTradeMart.",
                "IndianTradeMart, B2B marketplace, suppliers, manufacturers",
            ]
            for page, url in static_pages
        ])
        static_csv = buffer.getvalue()
        zip_file.writestr("02-static-important-pages.csv", static_csv)
        (MIRROR_DIR / "02-static-important-pages.csv").write_text(static_csv, encoding="utf-8", newline="")
        summary.append(["Static pages", len(static_pages)])

        total = write_chunks(
            zip_file,
            "03-product-detail-urls",
            ["Product ID", "Vendor ID", "Product", "Product Slug", "URL", "Title", "Description", "Keywords"],
            (
                [
                    p["id"],
                    p["vendor_id"],
                    p["name"],
                    slugify(p["slug"]),
                    f"{SITE}/product/{slugify(p['slug'])}",
                    *product_meta(p),
                ]
                for p in products
            ),
        )
        summary.append(["Product detail URLs", total])

        total = write_chunks(
            zip_file,
            "04-product-location-urls",
            ["Product ID", "Product", "Product Slug", "State", "District", "City", "URL", "Title", "Description", "Keywords"],
            (
                [p["id"], p["name"], slugify(p["slug"]), loc["state"], loc["district"], loc["city"], loc_url(slugify(p["slug"]), loc), *product_meta(p, loc)]
                for p in products
                for loc in locations
            ),
        )
        summary.append(["Product x all city URLs", total])

        total = write_chunks(
            zip_file,
            "05-vendor-location-urls",
            ["Vendor ID", "Vendor Internal ID", "Company", "Email", "State", "District", "City", "Profile URL", "Search URL", "Title", "Description", "Keywords"],
            (
                [
                    v["vendor_code"],
                    v["id"],
                    v["company"],
                    v["email"],
                    loc["state"],
                    loc["district"],
                    loc["city"],
                    f"{SITE}/directory/vendor/{slugify(v['slug'])}",
                    loc_url(slugify(v["slug"]), loc),
                    *vendor_meta(v, loc),
                ]
                for v in vendors
                for loc in locations
            ),
        )
        summary.append(["Vendor x all city URLs", total])

        total = write_chunks(
            zip_file,
            "06-vendor-service-location-urls",
            ["Vendor ID", "Company", "Service/Micro Category", "Service Slug", "State", "District", "City", "URL", "Title", "Description", "Keywords"],
            (
                [
                    vendor_id,
                    (vendor_by_id.get(vendor_id) or {}).get("company", "Unknown"),
                    micro["name"],
                    slugify(micro["slug"]),
                    loc["state"],
                    loc["district"],
                    loc["city"],
                    loc_url(slugify(micro["slug"]), loc),
                    *search_meta(micro["name"], loc, micro),
                ]
                for vendor_id, micro in service_pairs
                for loc in locations
            ),
        )
        summary.append(["Vendor service x all city URLs", total])

        if CATEGORY_SCOPE in {"used", "product", "products", "product-backed"}:
            export_micros = [micro for micro in micros if micro["id"] in used_micro_ids]
            category_label = "Product-backed category group x all city URLs"
        else:
            export_micros = micros
            category_label = "All category group x all city URLs"

        total = write_chunks(
            zip_file,
            "07-category-group-location-urls",
            ["Micro Category ID", "Micro Category", "Micro Slug", "Sub Category", "Head Category", "State", "District", "City", "URL", "Title", "Description", "Keywords"],
            (
                [
                    micro["id"],
                    micro["name"],
                    slugify(micro["slug"]),
                    micro["sub_name"],
                    micro["head_name"],
                    loc["state"],
                    loc["district"],
                    loc["city"],
                    loc_url(slugify(micro["slug"]), loc),
                    *search_meta(micro["name"], loc, micro),
                ]
                for micro in export_micros
                for loc in locations
            ),
        )
        summary.append([category_label, total])

        buffer = io.StringIO()
        writer = csv.writer(buffer)
        writer.writerow(["Sheet", "Rows"])
        writer.writerows(summary)
        summary_csv = buffer.getvalue()
        zip_file.writestr("00-summary.csv", summary_csv)
        (MIRROR_DIR / "00-summary.csv").write_text(summary_csv, encoding="utf-8", newline="")

    print(f"SEO URL export ready: {OUT}")
    print(f"SEO URL sitemap CSV mirror ready: {MIRROR_DIR}")
    print(f"Download URL: {SITE}/seo-url-exports/{OUT.name}")


if __name__ == "__main__":
    main()

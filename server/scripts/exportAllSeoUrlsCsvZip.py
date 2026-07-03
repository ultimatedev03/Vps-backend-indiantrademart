#!/usr/bin/env python3
import csv
import io
import os
import re
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
        zip_file.writestr(f"{base_name}-part-{part:03d}.csv", buffer.getvalue())
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
  COALESCE(NULLIF(hc.slug,''), LOWER(REPLACE(hc.name,' ','-')))
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
  ''
FROM micro_categories mc
LEFT JOIN sub_categories sc ON sc.id=mc.sub_category_id
WHERE COALESCE(mc.is_active,1)=1
ORDER BY sc.name, mc.name
"""

    micros = normalize_rows(
        mysql_query(micro_sql),
        ["id", "name", "slug", "sub_id", "sub_name", "sub_slug", "head_id", "head_name", "head_slug"],
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
            ["State ID", "State", "State Slug", "District ID", "District", "District Slug", "City ID", "City", "City Slug", "URL"],
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
        writer.writerow(["Page", "URL"])
        writer.writerows(static_pages)
        zip_file.writestr("02-static-important-pages.csv", buffer.getvalue())
        summary.append(["Static pages", len(static_pages)])

        total = write_chunks(
            zip_file,
            "03-product-detail-urls",
            ["Product ID", "Vendor ID", "Product", "Product Slug", "URL"],
            ([p["id"], p["vendor_id"], p["name"], slugify(p["slug"]), f"{SITE}/product/{slugify(p['slug'])}"] for p in products),
        )
        summary.append(["Product detail URLs", total])

        total = write_chunks(
            zip_file,
            "04-product-location-urls",
            ["Product ID", "Product", "Product Slug", "State", "District", "City", "URL"],
            (
                [p["id"], p["name"], slugify(p["slug"]), loc["state"], loc["district"], loc["city"], loc_url(slugify(p["slug"]), loc)]
                for p in products
                for loc in locations
            ),
        )
        summary.append(["Product x all city URLs", total])

        total = write_chunks(
            zip_file,
            "05-vendor-location-urls",
            ["Vendor ID", "Vendor Internal ID", "Company", "Email", "State", "District", "City", "Profile URL", "Search URL"],
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
                ]
                for v in vendors
                for loc in locations
            ),
        )
        summary.append(["Vendor x all city URLs", total])

        total = write_chunks(
            zip_file,
            "06-vendor-service-location-urls",
            ["Vendor ID", "Company", "Service/Micro Category", "Service Slug", "State", "District", "City", "URL"],
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
            ["Micro Category ID", "Micro Category", "Micro Slug", "Sub Category", "Head Category", "State", "District", "City", "URL"],
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
        zip_file.writestr("00-summary.csv", buffer.getvalue())

    print(f"SEO URL export ready: {OUT}")
    print(f"Download URL: {SITE}/seo-url-exports/{OUT.name}")


if __name__ == "__main__":
    main()

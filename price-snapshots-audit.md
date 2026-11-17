# جرد جدول الأسعار · 2026-11-17T23:16:00Z

**price_snapshots_schema**

```json
[{"sql":"CREATE TABLE price_snapshots (   id INTEGER PRIMARY KEY AUTOINCREMENT,   area_id INTEGER NOT NULL,   property_type TEXT NOT NULL,   transaction_type TEXT NOT NULL,   condition_type TEXT,   median_price_m2 REAL,   p25_price_m2 REAL,   p75_price_m2 REAL,   min_price_m2 REAL,   max_price_m2 REAL,   sample_count INTEGER NOT NULL DEFAULT 0,   confidence TEXT,   period TEXT NOT NULL,   calculated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, source_id INTEGER, source_url TEXT, observed_at TEXT, source_verified INTEGER NOT NULL DEFAULT 0, price_verified INTEGER NOT NULL DEFAULT 0, notes TEXT, avg_price_m2 REAL,   FOREIGN KEY (area_id) REFERENCES areas(id) )"}]
```

**areas_schema**

```json
[{"sql":"CREATE TABLE areas (   id INTEGER PRIMARY KEY AUTOINCREMENT,   name_ar TEXT NOT NULL UNIQUE,   name_en TEXT,   level TEXT,   level_ar TEXT,   description TEXT,   verified INTEGER NOT NULL DEFAULT 0,   created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,   updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP , area_type TEXT NOT NULL DEFAULT 'neighborhood')"}]
```

**rows_total**

```json
[{"rows_total":39}]
```

**areas_with_prices**

```json
[{"areas_with_prices":15}]
```

**areas_table_rows**

```json
[{"areas_table_rows":31}]
```

**listings_source9**

```json
[{"listings_source9":118}]
```

**freshness_observed_at**

```json
[{"oldest":"2026-09-28","newest":"2026-10-01 00:00:56"}]
```

**rows_per_month**

```json
[{"month":"2026-10","n":6},{"month":"2026-09","n":33}]
```

**rows_per_area_top40**

```json
[{"area_id":1,"n":7},{"area_id":24,"n":4},{"area_id":30,"n":3},{"area_id":26,"n":3},{"area_id":16,"n":3},{"area_id":14,"n":3},{"area_id":31,"n":2},{"area_id":29,"n":2},{"area_id":25,"n":2},{"area_id":23,"n":2},{"area_id":22,"n":2},{"area_id":17,"n":2},{"area_id":15,"n":2},{"area_id":27,"n":1},{"area_id":19,"n":1}]
```

**rows_last_30_days**

```json
[{"n":0}]
```


---

run: 44197828562 · commit: 7416b712ba1ed7a986c3e9a894587c2e77462fa2 · 2026-11-17T23:16:02Z
